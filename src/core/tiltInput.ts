import { clamp } from './math';

export type TiltControlStatus =
  | 'unsupported'
  | 'insecure'
  | 'inactive'
  | 'requesting'
  | 'calibrating'
  | 'active'
  | 'denied'
  | 'no-sensor';

export type ScreenOrientationDeg = 0 | 90 | 180 | 270;

export interface DeviceOrientationInputEvent {
  readonly alpha?: number | null;
  readonly beta?: number | null;
  readonly gamma?: number | null;
}

export interface DeviceMotionAccelerationLike {
  readonly x?: number | null;
  readonly y?: number | null;
  readonly z?: number | null;
}

export interface DeviceMotionInputEvent {
  readonly accelerationIncludingGravity?: DeviceMotionAccelerationLike | null;
}

export interface TiltPermissionConstructorLike {
  requestPermission?: () => Promise<'granted' | 'denied' | string>;
}

export interface ScreenOrientationLike {
  readonly angle?: number;
  addEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
}

export interface TiltNavigatorLike {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
}

export interface TiltPermissionHost {
  readonly isSecureContext?: boolean;
  readonly DeviceOrientationEvent?: TiltPermissionConstructorLike;
  readonly DeviceMotionEvent?: TiltPermissionConstructorLike;
  readonly orientation?: number;
  readonly screen?: {
    readonly orientation?: ScreenOrientationLike;
  };
  readonly navigator?: TiltNavigatorLike;
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
}

export interface TiltInputOptions {
  readonly deadzoneDeg?: number;
  readonly maxTiltDeg?: number;
  readonly maxCalibrationDeg?: number;
  readonly curveExponent?: number;
  readonly orientationSmoothTauSec?: number;
  readonly motionSmoothTauSec?: number;
  readonly noSensorTimeoutMs?: number;
  readonly accelGravitySign?: 1 | -1;
  readonly nowMs?: () => number;
}

const DEG_TO_RAD = Math.PI / 180;
const ORIENTATION_PRIORITY_MS = 500;
const MIN_GRAVITY_MAG_MPS2 = 3.0;
const MAX_GRAVITY_MAG_MPS2 = 22.0;

/**
 * Normalizes any screen orientation degree value (including negative values such as -90)
 * onto the canonical quarter-turn set `{0, 90, 180, 270}`.
 */
export function normalizeScreenAngle(angleDeg: number): ScreenOrientationDeg {
  if (!Number.isFinite(angleDeg)) return 0;
  const snapped = Math.round(angleDeg / 90) * 90;
  const mod = ((snapped % 360) + 360) % 360;
  switch (mod) {
    case 90:
      return 90;
    case 180:
      return 180;
    case 270:
      return 270;
    default:
      return 0;
  }
}

/**
 * Reads current screen rotation relative to the device's portrait reference frame.
 * Prefers numeric `window.orientation` when present because iOS 16.4+ Safari reports
 * `screen.orientation.angle` inverted (90 vs 270) relative to Android & legacy WebKit,
 * while Android and older Safari agree on `window.orientation`.
 * When `window.orientation` is absent (e.g., iPadOS Desktop Mode), compensates for WebKit's
 * 90/270 inversion when running on iOS/iPadOS.
 */
export function readScreenOrientationDeg(host: TiltPermissionHost | null): ScreenOrientationDeg {
  if (!host) return 0;
  if (typeof host.orientation === 'number' && Number.isFinite(host.orientation)) {
    return normalizeScreenAngle(host.orientation);
  }
  const screenAngle = host.screen?.orientation?.angle;
  if (typeof screenAngle === 'number' && Number.isFinite(screenAngle)) {
    const normalized = normalizeScreenAngle(screenAngle);
    if (detectIOSAccelerometerSign(host) === 1) {
      if (normalized === 90) return 270;
      if (normalized === 270) return 90;
    }
    return normalized;
  }
  return 0;
}

/**
 * Resolves the sign multiplier needed to convert `accelerationIncludingGravity`
 * into a downward gravity vector in device-local coordinates:
 * - W3C / Android Chrome measures reaction force (+Z when screen faces sky), so downward = `-1 * a`.
 * - iOS / iPadOS Safari measures gravity-aligned acceleration (-Z when screen faces sky), so downward = `+1 * a`.
 */
export function detectIOSAccelerometerSign(host: TiltPermissionHost | null): 1 | -1 {
  if (!host) return -1;
  if (
    typeof host.DeviceMotionEvent?.requestPermission === 'function' ||
    typeof host.DeviceOrientationEvent?.requestPermission === 'function'
  ) {
    return 1;
  }
  const nav = host.navigator;
  if (!nav) return -1;
  const ua = nav.userAgent ?? '';
  if (/\b(iPhone|iPad|iPod)\b/i.test(ua)) {
    return 1;
  }
  if (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1) {
    return 1;
  }
  return -1;
}

/**
 * Projects a device-local downward gravity vector `(gx, gy, gz)` onto the current
 * screen-right axis, returning a signed lateral tilt angle in `[-PI/2, +PI/2]` radians
 * where positive means tilting the right edge of the screen downward (steer right).
 */
export function projectGravityToLateralTiltRad(
  gx: number,
  gy: number,
  gz: number,
  screenAngle: ScreenOrientationDeg,
): number | null {
  if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)) {
    return null;
  }
  const mag = Math.hypot(gx, gy, gz);
  if (mag < 1e-4) {
    return null;
  }

  const invMag = 1 / mag;
  const ux = gx * invMag;
  const uy = gy * invMag;

  let lateralG: number;
  switch (screenAngle) {
    case 90:
      lateralG = -uy;
      break;
    case 180:
      lateralG = -ux;
      break;
    case 270:
      lateralG = uy;
      break;
    case 0:
    default:
      lateralG = ux;
      break;
  }

  return Math.asin(clamp(lateralG, -1, 1));
}

/**
 * Computes lateral tilt angle from W3C `DeviceOrientationEvent` (`beta`, `gamma` in degrees).
 * Reconstructs the downward unit gravity vector `g_dev = (cos(b)*sin(g), -sin(b), -cos(b)*cos(g))`
 * from the Z-X'-Y'' rotation matrix so tilt stays continuous across steep upright holds.
 */
export function computeTiltFromOrientation(
  betaDeg: number,
  gammaDeg: number,
  screenAngle: ScreenOrientationDeg,
): number | null {
  if (!Number.isFinite(betaDeg) || !Number.isFinite(gammaDeg)) {
    return null;
  }
  const b = betaDeg * DEG_TO_RAD;
  const g = gammaDeg * DEG_TO_RAD;
  const cosB = Math.cos(b);
  const sinB = Math.sin(b);
  const cosG = Math.cos(g);
  const sinG = Math.sin(g);

  const gx = cosB * sinG;
  const gy = -sinB;
  const gz = -cosB * cosG;

  return projectGravityToLateralTiltRad(gx, gy, gz, screenAngle);
}

/**
 * Computes lateral tilt angle from `DeviceMotionEvent.accelerationIncludingGravity` (`m/s^2`).
 * Rejects non-finite readings and extreme shake/free-fall transients outside `[3, 22] m/s^2`.
 */
export function computeTiltFromAcceleration(
  ax: number,
  ay: number,
  az: number,
  screenAngle: ScreenOrientationDeg,
  gravitySign: 1 | -1,
): number | null {
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) {
    return null;
  }
  const mag = Math.hypot(ax, ay, az);
  if (mag < MIN_GRAVITY_MAG_MPS2 || mag > MAX_GRAVITY_MAG_MPS2) {
    return null;
  }
  return projectGravityToLateralTiltRad(
    ax * gravitySign,
    ay * gravitySign,
    az * gravitySign,
    screenAngle,
  );
}

/**
 * Maps a signed lateral tilt angle relative to `neutralRad` into normalized steering `[-1, 1]`
 * with deadzone rejection and gentle non-linear response curve.
 */
export function mapTiltRadToSteer(
  tiltRad: number,
  neutralRad: number,
  deadzoneRad: number,
  maxTiltRad: number,
  curveExponent: number,
): number {
  const delta = tiltRad - neutralRad;
  const absDelta = Math.abs(delta);
  if (absDelta <= deadzoneRad) {
    return 0;
  }
  const span = Math.max(1e-4, maxTiltRad - deadzoneRad);
  const norm = clamp((absDelta - deadzoneRad) / span, 0, 1);
  const curved = Math.pow(norm, curveExponent);
  return delta >= 0 ? curved : -curved;
}

/**
 * Cross-platform mobile accelerometer & tilt steering controller.
 * Supports iOS/iPadOS 13+ permission flow, Android/W3C sign normalization,
 * automatic screen-orientation axis remapping, calibration, and zero-allocation sampling.
 */
export class TiltInputController {
  private readonly deadzoneRad: number;
  private readonly maxTiltRad: number;
  private readonly maxCalibrationRad: number;
  private readonly curveExponent: number;
  private readonly orientationSmoothTauSec: number;
  private readonly motionSmoothTauSec: number;
  private readonly noSensorTimeoutMs: number;
  private readonly overrideGravitySign: (1 | -1) | null;
  private readonly nowMs: () => number;

  private host: TiltPermissionHost | null = null;
  private listenersAttached = false;
  private _enabled = false;
  private _status: TiltControlStatus = 'unsupported';
  private gravitySign: 1 | -1 = -1;
  private requestGeneration = 0;
  private pendingEnablePromise: Promise<TiltControlStatus> | null = null;
  private pendingEnableGen = 0;

  private enabledAtMs = 0;
  private lastOrientationEventMs = -Infinity;
  private lastSampleMs = -Infinity;

  private hasFilteredTilt = false;
  private filteredTiltRad = 0;
  private neutralTiltRad = 0;
  private pendingCalibration = true;
  private steerValue = 0;

  private readonly onDeviceOrientationListener = (ev: unknown): void => {
    this.handleDeviceOrientation(ev as DeviceOrientationInputEvent);
  };
  private readonly onDeviceMotionListener = (ev: unknown): void => {
    this.handleDeviceMotion(ev as DeviceMotionInputEvent);
  };
  private readonly onOrientationChangeListener = (): void => {
    this.handleOrientationChange();
  };

  constructor(options: TiltInputOptions = {}) {
    this.deadzoneRad = (options.deadzoneDeg ?? 3.0) * DEG_TO_RAD;
    this.maxTiltRad = (options.maxTiltDeg ?? 26.0) * DEG_TO_RAD;
    this.maxCalibrationRad = (options.maxCalibrationDeg ?? 18.0) * DEG_TO_RAD;
    this.curveExponent = options.curveExponent ?? 1.35;
    this.orientationSmoothTauSec = options.orientationSmoothTauSec ?? 0.045;
    this.motionSmoothTauSec = options.motionSmoothTauSec ?? 0.085;
    this.noSensorTimeoutMs = options.noSensorTimeoutMs ?? 1800;
    this.overrideGravitySign = options.accelGravitySign ?? null;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get status(): TiltControlStatus {
    return this._status;
  }

  get isActivelySteering(): boolean {
    return this._enabled && this._status === 'active';
  }

  get requiresExplicitPermission(): boolean {
    return Boolean(
      typeof this.host?.DeviceOrientationEvent?.requestPermission === 'function' ||
        typeof this.host?.DeviceMotionEvent?.requestPermission === 'function',
    );
  }

  attach(host: TiltPermissionHost): void {
    this.detach();
    this.host = host;
    this.gravitySign = this.overrideGravitySign ?? detectIOSAccelerometerSign(host);
    this._status = this.computeBaseStatus();
  }

  detach(): void {
    this.disable();
    this.host = null;
    this._status = 'unsupported';
  }

  /**
   * Requests motion/orientation access (must be called synchronously inside a user
   * gesture handler on iOS 13+ Safari/iPadOS) and starts listening to sensor events.
   * Coalesces concurrent calls while an iOS permission prompt is already pending.
   */
  enable(): Promise<TiltControlStatus> {
    if (this._status === 'requesting' && this.pendingEnablePromise) {
      return this.pendingEnablePromise;
    }

    const gen = ++this.requestGeneration;
    const base = this.computeBaseStatus();
    if (base === 'unsupported' || base === 'insecure') {
      this._enabled = false;
      this._status = base;
      return Promise.resolve(base);
    }

    if (this._enabled && this.listenersAttached && this._status !== 'no-sensor') {
      return Promise.resolve(this._status);
    }

    const host = this.host!;
    const reqOrientation = host.DeviceOrientationEvent?.requestPermission;
    const reqMotion = host.DeviceMotionEvent?.requestPermission;

    // Trigger iOS permission prompts synchronously before any await to preserve transient user activation
    const pendingRequests: Promise<unknown>[] = [];
    if (typeof reqOrientation === 'function') {
      try {
        pendingRequests.push(Promise.resolve(reqOrientation.call(host.DeviceOrientationEvent)));
      } catch (err) {
        pendingRequests.push(Promise.reject(err));
      }
    }
    if (typeof reqMotion === 'function') {
      try {
        pendingRequests.push(Promise.resolve(reqMotion.call(host.DeviceMotionEvent)));
      } catch (err) {
        pendingRequests.push(Promise.reject(err));
      }
    }

    if (pendingRequests.length > 0) {
      this._status = 'requesting';
      this.pendingEnableGen = gen;
      const promise = Promise.allSettled(pendingRequests)
        .then((settled): TiltControlStatus => {
          if (gen !== this.requestGeneration || this.host !== host) {
            return this._status;
          }
          const anyGranted = settled.some(
            (res) => res.status === 'fulfilled' && res.value === 'granted',
          );
          if (!anyGranted) {
            this._enabled = false;
            this._status = 'denied';
            return 'denied';
          }
          return this.activateListeners(host);
        })
        .finally(() => {
          if (this.pendingEnableGen === gen) {
            this.pendingEnablePromise = null;
          }
        });
      this.pendingEnablePromise = promise;
      return promise;
    }

    return Promise.resolve(this.activateListeners(host));
  }

  private activateListeners(host: TiltPermissionHost): TiltControlStatus {
    this._enabled = true;
    this._status = 'calibrating';
    this.enabledAtMs = this.nowMs();
    this.lastOrientationEventMs = -Infinity;
    this.lastSampleMs = -Infinity;
    this.hasFilteredTilt = false;
    this.filteredTiltRad = 0;
    this.neutralTiltRad = 0;
    this.pendingCalibration = true;
    this.steerValue = 0;

    this.attachSensorListeners(host);
    return this._status;
  }

  disable(): void {
    this.requestGeneration++;
    this.pendingEnablePromise = null;
    this.detachSensorListeners();
    this._enabled = false;
    this.hasFilteredTilt = false;
    this.filteredTiltRad = 0;
    this.neutralTiltRad = 0;
    this.pendingCalibration = true;
    this.lastOrientationEventMs = -Infinity;
    this.lastSampleMs = -Infinity;
    this.steerValue = 0;
    this._status = this.computeBaseStatus();
  }

  recenter(): void {
    if (!this._enabled) return;
    if (this.hasFilteredTilt) {
      this.neutralTiltRad = clamp(
        this.filteredTiltRad,
        -this.maxCalibrationRad,
        this.maxCalibrationRad,
      );
      this.pendingCalibration = false;
      this._status = 'active';
      this.steerValue = mapTiltRadToSteer(
        this.filteredTiltRad,
        this.neutralTiltRad,
        this.deadzoneRad,
        this.maxTiltRad,
        this.curveExponent,
      );
    } else {
      this.pendingCalibration = true;
      this.steerValue = 0;
      if (this.listenersAttached && this._status === 'active') {
        this._status = 'calibrating';
        this.enabledAtMs = this.nowMs();
      }
    }
  }

  /**
   * Zeroes transient steering across start/pause/restart transitions while keeping
   * tilt mode enabled and preserving an already-established neutral hold calibration.
   */
  resetForTransition(): void {
    this.steerValue = 0;
    this.lastSampleMs = -Infinity;
    if (!this._enabled) return;

    if (this.listenersAttached && this._status === 'active' && this.hasFilteredTilt && !this.pendingCalibration) {
      return;
    }

    this.hasFilteredTilt = false;
    this.pendingCalibration = true;
    if (this.listenersAttached && this._status !== 'no-sensor') {
      this._status = 'calibrating';
      this.enabledAtMs = this.nowMs();
    }
  }

  handleOrientationChange(): void {
    this.hasFilteredTilt = false;
    this.neutralTiltRad = 0;
    this.pendingCalibration = true;
    this.lastSampleMs = -Infinity;
    this.steerValue = 0;
    if (this._enabled && this.listenersAttached && this._status !== 'no-sensor') {
      this._status = 'calibrating';
      this.enabledAtMs = this.nowMs();
    }
  }

  handleDeviceOrientation(event: DeviceOrientationInputEvent): void {
    if (!this._enabled) return;
    const beta = event.beta;
    const gamma = event.gamma;
    if (
      typeof beta !== 'number' ||
      typeof gamma !== 'number' ||
      !Number.isFinite(beta) ||
      !Number.isFinite(gamma)
    ) {
      return;
    }

    const screenAngle = readScreenOrientationDeg(this.host);
    const tiltRad = computeTiltFromOrientation(beta, gamma, screenAngle);
    if (tiltRad === null) return;

    const now = this.nowMs();
    this.lastOrientationEventMs = now;
    this.ingestTiltRad(tiltRad, now, this.orientationSmoothTauSec);
  }

  handleDeviceMotion(event: DeviceMotionInputEvent): void {
    if (!this._enabled) return;
    const now = this.nowMs();
    // Prefer sensor-fused deviceorientation when active recently
    if (now - this.lastOrientationEventMs <= ORIENTATION_PRIORITY_MS) {
      return;
    }

    const acc = event.accelerationIncludingGravity;
    if (!acc) return;
    const ax = acc.x;
    const ay = acc.y;
    const az = acc.z;
    if (
      typeof ax !== 'number' ||
      typeof ay !== 'number' ||
      typeof az !== 'number'
    ) {
      return;
    }

    const screenAngle = readScreenOrientationDeg(this.host);
    const tiltRad = computeTiltFromAcceleration(ax, ay, az, screenAngle, this.gravitySign);
    if (tiltRad === null) return;

    this.ingestTiltRad(tiltRad, now, this.motionSmoothTauSec);
  }

  sampleSteer(): number {
    if (!this._enabled) return 0;
    if (this._status === 'calibrating') {
      if (this.nowMs() - this.enabledAtMs >= this.noSensorTimeoutMs) {
        this._status = 'no-sensor';
      }
      return 0;
    }
    if (this._status !== 'active') {
      return 0;
    }
    return this.steerValue;
  }

  private ingestTiltRad(rawTiltRad: number, nowMs: number, tauSec: number): void {
    if (!this.hasFilteredTilt || !Number.isFinite(this.lastSampleMs)) {
      this.filteredTiltRad = rawTiltRad;
      this.hasFilteredTilt = true;
    } else {
      const dtSec = clamp((nowMs - this.lastSampleMs) * 0.001, 0, 0.25);
      const alpha = dtSec > 0 ? 1 - Math.exp(-dtSec / Math.max(1e-4, tauSec)) : 0;
      this.filteredTiltRad += (rawTiltRad - this.filteredTiltRad) * alpha;
    }
    this.lastSampleMs = nowMs;

    if (this.pendingCalibration) {
      this.neutralTiltRad = clamp(
        this.filteredTiltRad,
        -this.maxCalibrationRad,
        this.maxCalibrationRad,
      );
      this.pendingCalibration = false;
    }

    this._status = 'active';
    this.steerValue = mapTiltRadToSteer(
      this.filteredTiltRad,
      this.neutralTiltRad,
      this.deadzoneRad,
      this.maxTiltRad,
      this.curveExponent,
    );
  }

  private computeBaseStatus(): TiltControlStatus {
    const host = this.host;
    if (!host) return 'unsupported';
    const hasSensors =
      Boolean(host.DeviceOrientationEvent) || Boolean(host.DeviceMotionEvent);
    if (!hasSensors) {
      return 'unsupported';
    }
    if (host.isSecureContext === false) {
      return 'insecure';
    }
    return 'inactive';
  }

  private attachSensorListeners(host: TiltPermissionHost): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    host.addEventListener('deviceorientation', this.onDeviceOrientationListener, { passive: true });
    host.addEventListener('devicemotion', this.onDeviceMotionListener, { passive: true });
    host.addEventListener('orientationchange', this.onOrientationChangeListener);
    host.screen?.orientation?.addEventListener?.('change', this.onOrientationChangeListener);
  }

  private detachSensorListeners(): void {
    if (!this.listenersAttached || !this.host) return;
    this.listenersAttached = false;
    this.host.removeEventListener('deviceorientation', this.onDeviceOrientationListener);
    this.host.removeEventListener('devicemotion', this.onDeviceMotionListener);
    this.host.removeEventListener('orientationchange', this.onOrientationChangeListener);
    this.host.screen?.orientation?.removeEventListener?.('change', this.onOrientationChangeListener);
  }
}
