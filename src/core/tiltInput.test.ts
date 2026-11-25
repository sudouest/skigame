import { describe, expect, it } from 'vitest';
import {
  TiltInputController,
  computeTiltFromAcceleration,
  computeTiltFromOrientation,
  detectIOSAccelerometerSign,
  mapTiltRadToSteer,
  normalizeScreenAngle,
  readScreenOrientationDeg,
  type TiltPermissionHost,
} from './tiltInput';

class MockTiltHost implements TiltPermissionHost {
  isSecureContext: boolean | undefined = true;
  orientation: number | undefined = 0;
  screen: {
    orientation?: {
      angle?: number;
      addEventListener?: (type: string, fn: (ev: unknown) => void) => void;
      removeEventListener?: (type: string, fn: (ev: unknown) => void) => void;
    };
  } = {
    orientation: {
      angle: 0,
      addEventListener: (type, fn) => {
        this.addScreenListener(type, fn);
      },
      removeEventListener: (type, fn) => {
        this.removeScreenListener(type, fn);
      },
    },
  };
  navigator: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined = {
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
  };
  DeviceOrientationEvent: { requestPermission?: () => Promise<string> } | undefined = {};
  DeviceMotionEvent: { requestPermission?: () => Promise<string> } | undefined = {};

  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  private readonly screenListeners = new Map<string, Set<(ev: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private addScreenListener(type: string, listener: (ev: unknown) => void): void {
    let set = this.screenListeners.get(type);
    if (!set) {
      set = new Set();
      this.screenListeners.set(type, set);
    }
    set.add(listener);
  }

  private removeScreenListener(type: string, listener: (ev: unknown) => void): void {
    this.screenListeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }

  dispatchScreenChange(): void {
    for (const fn of this.screenListeners.get('change') ?? []) {
      fn({});
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  screenListenerCount(type: string): number {
    return this.screenListeners.get(type)?.size ?? 0;
  }
}

describe('tiltInput pure math & platform normalization', () => {
  it('normalizes screen angles and prioritizes window.orientation to avoid iOS 16.4+ landscape inversion', () => {
    expect(normalizeScreenAngle(0)).toBe(0);
    expect(normalizeScreenAngle(90)).toBe(90);
    expect(normalizeScreenAngle(-90)).toBe(270);
    expect(normalizeScreenAngle(270)).toBe(270);
    expect(normalizeScreenAngle(180)).toBe(180);
    expect(normalizeScreenAngle(NaN)).toBe(0);

    const iosBuggyHost = new MockTiltHost();
    iosBuggyHost.orientation = 90;
    iosBuggyHost.screen = { orientation: { angle: 270 } };
    expect(readScreenOrientationDeg(iosBuggyHost)).toBe(90);

    const modernAndroidHost = new MockTiltHost();
    modernAndroidHost.orientation = undefined;
    modernAndroidHost.screen = { orientation: { angle: 270 } };
    expect(readScreenOrientationDeg(modernAndroidHost)).toBe(270);

    // iPadOS Desktop Mode (window.orientation === undefined) compensates for WebKit 90/270 flip
    const ipadDesktopFallback = new MockTiltHost();
    ipadDesktopFallback.orientation = undefined;
    ipadDesktopFallback.navigator = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    };
    ipadDesktopFallback.screen = { orientation: { angle: 270 } };
    expect(readScreenOrientationDeg(ipadDesktopFallback)).toBe(90);
    ipadDesktopFallback.screen = { orientation: { angle: 90 } };
    expect(readScreenOrientationDeg(ipadDesktopFallback)).toBe(270);
  });

  it('detects iOS/iPadOS (including iPad desktop UA) vs Android accelerometer gravity signs', () => {
    const android = new MockTiltHost();
    expect(detectIOSAccelerometerSign(android)).toBe(-1);

    const iphone = new MockTiltHost();
    iphone.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' };
    iphone.DeviceMotionEvent = { requestPermission: async () => 'granted' };
    expect(detectIOSAccelerometerSign(iphone)).toBe(1);

    const ipadDesktopUa = new MockTiltHost();
    ipadDesktopUa.navigator = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    };
    expect(detectIOSAccelerometerSign(ipadDesktopUa)).toBe(1);

    const macDesktop = new MockTiltHost();
    macDesktop.navigator = {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    };
    expect(detectIOSAccelerometerSign(macDesktop)).toBe(-1);
  });

  it('computes consistent right/left tilt across portrait and landscape screen orientations', () => {
    const deg = 180 / Math.PI;

    // Portrait (0 deg): tilting right edge down -> positive gamma -> +tilt
    expect(computeTiltFromOrientation(30, 20, 0)! * deg).toBeGreaterThan(15);
    expect(computeTiltFromOrientation(30, -20, 0)! * deg).toBeLessThan(-15);

    // Upside-down portrait (180 deg): inverted sign
    expect(computeTiltFromOrientation(30, 20, 180)! * deg).toBeLessThan(-15);

    // Landscape 90 deg (top of phone left, bottom right): tilting right/bottom down -> beta > 0 -> +tilt
    expect(computeTiltFromOrientation(25, 0, 90)! * deg).toBeCloseTo(25, 4);
    expect(computeTiltFromOrientation(-25, 0, 90)! * deg).toBeCloseTo(-25, 4);

    // Landscape 270 deg (top of phone right, bottom left): tilting right/top down -> beta < 0 -> +tilt
    expect(computeTiltFromOrientation(-25, 0, 270)! * deg).toBeCloseTo(25, 4);
    expect(computeTiltFromOrientation(25, 0, 270)! * deg).toBeCloseTo(-25, 4);

    // Continuity across steep vertical transition (beta=60,gamma=+89 vs beta=120,gamma=-89)
    const beforeFlip = computeTiltFromOrientation(60, 89, 0)!;
    const afterFlip = computeTiltFromOrientation(120, -89, 0)!;
    expect(Math.abs(beforeFlip - afterFlip)).toBeLessThan(1e-3);
  });

  it('normalizes accelerationIncludingGravity for Android (-1) and iOS (+1) and rejects transients', () => {
    const deg = 180 / Math.PI;
    // Android (W3C): tilting right edge down means gravity pulls +X -> reaction force is -X
    const androidRight = computeTiltFromAcceleration(-4.9, 0, 8.49, 0, -1)!;
    expect(androidRight * deg).toBeCloseTo(30, 0);

    // iOS: tilting right edge down reports +X acceleration
    const iosRight = computeTiltFromAcceleration(4.9, 0, -8.49, 0, 1)!;
    expect(iosRight * deg).toBeCloseTo(30, 0);

    // Landscape 90 deg on Android: tilting right edge (bottom/-Y) down -> reaction force is +Y -> ay > 0
    const androidLand90Right = computeTiltFromAcceleration(0, 4.9, 8.49, 90, -1)!;
    expect(androidLand90Right * deg).toBeCloseTo(30, 0);

    // Upside-down portrait (180 deg) & landscape 270 deg on Android (-1) and iOS (+1)
    expect(computeTiltFromAcceleration(4.9, 0, 8.49, 180, -1)! * deg).toBeCloseTo(30, 0);
    expect(computeTiltFromAcceleration(-4.9, 0, -8.49, 180, 1)! * deg).toBeCloseTo(30, 0);
    expect(computeTiltFromAcceleration(0, -4.9, 8.49, 270, -1)! * deg).toBeCloseTo(30, 0);
    expect(computeTiltFromAcceleration(0, 4.9, -8.49, 270, 1)! * deg).toBeCloseTo(30, 0);

    // Free-fall and heavy shake spikes rejected
    expect(computeTiltFromAcceleration(0.1, 0.2, 0.3, 0, -1)).toBeNull();
    expect(computeTiltFromAcceleration(18, 18, 0, 0, -1)).toBeNull();
  });

  it('maps tilt angles with deadzone and response curve cleanly around level 0 deg', () => {
    const d2r = Math.PI / 180;
    expect(mapTiltRadToSteer(2 * d2r, 3 * d2r, 26 * d2r, 1.35)).toBe(0);
    expect(mapTiltRadToSteer(-2.5 * d2r, 3 * d2r, 26 * d2r, 1.35)).toBe(0);
    expect(mapTiltRadToSteer(26 * d2r, 3 * d2r, 26 * d2r, 1.35)).toBeCloseTo(1, 6);
    expect(mapTiltRadToSteer(-35 * d2r, 3 * d2r, 26 * d2r, 1.35)).toBeCloseTo(-1, 6);
    const mid = mapTiltRadToSteer(14.5 * d2r, 3 * d2r, 26 * d2r, 1.35);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.5);
  });
});

describe('TiltInputController lifecycle, permissions, and fallback', () => {
  it('handles iOS requestPermission synchronously in enable(), denial, and disable race cleanly', async () => {
    let now = 1000;
    const host = new MockTiltHost();
    host.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1)' };
    let resolvePerm!: (val: string) => void;
    let calledSync = false;

    host.DeviceOrientationEvent = {
      requestPermission: () => {
        calledSync = true;
        return new Promise((res) => {
          resolvePerm = res;
        });
      },
    };
    host.DeviceMotionEvent = {
      requestPermission: async () => 'granted',
    };

    const ctrl = new TiltInputController({ nowMs: () => now });
    ctrl.attach(host);
    expect(ctrl.requiresExplicitPermission).toBe(true);
    expect(ctrl.status).toBe('inactive');

    // Race test: disable while permission prompt is still pending
    const pendingEnable = ctrl.enable();
    expect(calledSync).toBe(true);
    expect(ctrl.status).toBe('requesting');
    ctrl.disable();
    resolvePerm('granted');
    await pendingEnable;
    expect(ctrl.enabled).toBe(false);
    expect(ctrl.status).toBe('inactive');
    expect(host.listenerCount('deviceorientation')).toBe(0);

    // Denied test
    host.DeviceOrientationEvent.requestPermission = async () => 'denied';
    host.DeviceMotionEvent.requestPermission = async () => 'denied';
    const deniedStatus = await ctrl.enable();
    expect(deniedStatus).toBe('denied');
    expect(ctrl.enabled).toBe(false);

    // Granted test -> waiting -> active on first finite sensor sample
    host.DeviceOrientationEvent.requestPermission = async () => 'granted';
    host.DeviceMotionEvent.requestPermission = async () => 'granted';
    const okStatus = await ctrl.enable();
    expect(okStatus).toBe('waiting');
    expect(ctrl.enabled).toBe(true);
    expect(host.listenerCount('deviceorientation')).toBe(1);
    expect(host.listenerCount('devicemotion')).toBe(1);
    expect(host.screenListenerCount('change')).toBe(1);

    // Null readings (e.g. desktop Chrome without sensors) must be ignored
    host.dispatch('deviceorientation', { alpha: null, beta: null, gamma: null });
    expect(ctrl.status).toBe('waiting');

    // Non-zero initial tilt immediately steers relative to fixed 0 deg level horizon (no auto-calibration)
    host.dispatch('deviceorientation', { alpha: 0, beta: 35, gamma: 20 });
    expect(ctrl.status).toBe('active');
    expect(ctrl.sampleSteer()).toBeGreaterThan(0.4);

    // Returning to level horizon (0 deg) returns steer to 0 cleanly
    now += 400;
    host.dispatch('deviceorientation', { alpha: 0, beta: 35, gamma: 0 });
    expect(ctrl.sampleSteer()).toBeCloseTo(0, 5);

    // Screen orientation change resets filter and enters waiting
    host.orientation = 90;
    host.dispatchScreenChange();
    expect(ctrl.status).toBe('waiting');
    expect(ctrl.sampleSteer()).toBe(0);

    ctrl.detach();
    expect(host.listenerCount('deviceorientation')).toBe(0);
    expect(host.listenerCount('devicemotion')).toBe(0);
    expect(host.screenListenerCount('change')).toBe(0);
  });

  it('coalesces concurrent enable(), handles permission throws/rejections/partial grants, same-ms filter, and resetForTransition()', async () => {
    let now = 3000;
    const host = new MockTiltHost();
    let resolvePerm!: (val: string) => void;
    let permCalls = 0;

    host.DeviceOrientationEvent = {
      requestPermission: () => {
        permCalls++;
        return new Promise((res) => {
          resolvePerm = res;
        });
      },
    };
    host.DeviceMotionEvent = {};

    const ctrl = new TiltInputController({ nowMs: () => now });
    ctrl.attach(host);

    // Concurrent double-tap while requesting coalesces into one prompt
    const p1 = ctrl.enable();
    const p2 = ctrl.enable();
    expect(p1).toBe(p2);
    expect(permCalls).toBe(1);
    resolvePerm('granted');
    expect(await p1).toBe('waiting');

    // First valid sample establishes active level 0 deg; same-ms spike (dtSec === 0) must be smoothed away (alpha=0)
    host.dispatch('deviceorientation', { alpha: 0, beta: 20, gamma: 0 });
    expect(ctrl.status).toBe('active');
    host.dispatch('deviceorientation', { alpha: 0, beta: 20, gamma: 30 });
    expect(ctrl.sampleSteer()).toBe(0);

    // Tilt right, then resetForTransition() zeroes transient steer while keeping level 0 deg neutral
    now += 300;
    host.dispatch('deviceorientation', { alpha: 0, beta: 0, gamma: 15 });
    expect(ctrl.sampleSteer()).toBeGreaterThan(0.3);
    ctrl.resetForTransition();
    expect(ctrl.status).toBe('active');
    expect(ctrl.sampleSteer()).toBe(0);
    now += 20;
    host.dispatch('deviceorientation', { alpha: 0, beta: 0, gamma: 0 });
    expect(ctrl.sampleSteer()).toBeCloseTo(0, 5);

    // Synchronous throw + async rejection + partial grant behavior
    ctrl.disable();
    host.DeviceOrientationEvent = {
      requestPermission: () => {
        throw new Error('gesture expired');
      },
    };
    host.DeviceMotionEvent = {
      requestPermission: () => Promise.reject(new Error('blocked')),
    };
    expect(await ctrl.enable()).toBe('denied');

    host.DeviceMotionEvent = {
      requestPermission: async () => 'granted',
    };
    expect(await ctrl.enable()).toBe('waiting');
  });

  it('falls back to devicemotion when deviceorientation is absent and detects insecure/no-sensor states', async () => {
    let now = 5000;
    const host = new MockTiltHost();
    host.isSecureContext = false;
    const ctrl = new TiltInputController({ noSensorTimeoutMs: 1000, nowMs: () => now });
    ctrl.attach(host);
    expect(ctrl.status).toBe('insecure');
    expect(await ctrl.enable()).toBe('insecure');

    // Secure context without sensors delivering events transitions to 'no-sensor'
    host.isSecureContext = true;
    ctrl.attach(host);
    expect(await ctrl.enable()).toBe('waiting');
    expect(ctrl.sampleSteer()).toBe(0);
    now += 1100;
    expect(ctrl.sampleSteer()).toBe(0);
    expect(ctrl.status).toBe('no-sensor');

    // Retrying enable() from 'no-sensor' when permission is denied detaches sensor listeners cleanly
    host.DeviceOrientationEvent = { requestPermission: async () => 'denied' };
    host.DeviceMotionEvent = { requestPermission: async () => 'denied' };
    expect(await ctrl.enable()).toBe('denied');
    expect(host.listenerCount('deviceorientation')).toBe(0);
    expect(host.listenerCount('devicemotion')).toBe(0);

    // Re-enable (no permission prompt) and drive solely via devicemotion (Android reaction force)
    host.DeviceOrientationEvent = {};
    host.DeviceMotionEvent = {};
    expect(await ctrl.enable()).toBe('waiting');
    host.dispatch('devicemotion', {
      accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 },
    });
    expect(ctrl.status).toBe('active');
    expect(ctrl.sampleSteer()).toBe(0);

    now += 300;
    host.dispatch('devicemotion', {
      accelerationIncludingGravity: { x: -4.9, y: 0, z: 8.49 },
    });
    expect(ctrl.sampleSteer()).toBeGreaterThan(0.5);
  });
});
