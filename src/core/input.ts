import {
  TiltInputController,
  type DeviceMotionInputEvent,
  type DeviceOrientationInputEvent,
  type TiltControlStatus,
  type TiltInputOptions,
  type TiltPermissionHost,
} from './tiltInput';

export type {
  DeviceMotionAccelerationLike,
  DeviceMotionInputEvent,
  DeviceOrientationInputEvent,
  ScreenOrientationDeg,
  TiltControlStatus,
  TiltInputOptions,
  TiltPermissionHost,
} from './tiltInput';

export interface InputEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  readonly clientWidth?: number;
  readonly innerWidth?: number;
}

export interface KeyboardInputEvent {
  readonly code?: string;
  readonly key?: string;
  readonly repeat?: boolean;
  preventDefault?: () => void;
}

export interface PointerInputEvent {
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly isPrimary?: boolean;
}

export interface TouchPointLike {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface TouchInputEvent {
  readonly touches: {
    readonly length: number;
    [index: number]: TouchPointLike | undefined;
  };
  readonly changedTouches?: {
    readonly length: number;
    [index: number]: TouchPointLike | undefined;
  };
}

export interface InputFrameState {
  readonly steer: number;
  readonly dragDelta: number;
  readonly dragDeltaPx: number;
  readonly jumpHeld: boolean;
  readonly jumpPressed: boolean;
  readonly brakeHeld: boolean;
  readonly toggleBlizzardPressed: boolean;
  readonly toggleDebugPressed: boolean;
  readonly toggleProfilerPressed: boolean;
  readonly togglePausePressed: boolean;
  readonly hasSteered: boolean;
}

export interface MutableInputFrameState {
  steer: number;
  dragDelta: number;
  dragDeltaPx: number;
  jumpHeld: boolean;
  jumpPressed: boolean;
  brakeHeld: boolean;
  toggleBlizzardPressed: boolean;
  toggleDebugPressed: boolean;
  toggleProfilerPressed: boolean;
  togglePausePressed: boolean;
  hasSteered: boolean;
}

export function createInputFrameState(): MutableInputFrameState {
  return {
    steer: 0,
    dragDelta: 0,
    dragDeltaPx: 0,
    jumpHeld: false,
    jumpPressed: false,
    brakeHeld: false,
    toggleBlizzardPressed: false,
    toggleDebugPressed: false,
    toggleProfilerPressed: false,
    togglePausePressed: false,
    hasSteered: false,
  };
}

export interface InputManagerOptions {
  readonly dragSensitivity?: number;
  readonly tapMaxDurationMs?: number;
  readonly tapMaxMovePx?: number;
  readonly swipeJumpThresholdPx?: number;
  readonly swipeJumpMaxDurationMs?: number;
  readonly defaultViewportWidthPx?: number;
  readonly nowMs?: () => number;
  readonly tilt?: TiltInputOptions;
}

interface ActivePointerTrack {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTimeMs: number;
  movedDistPx: number;
  swipeJumped: boolean;
}

/**
 * Headless-capable keyboard, pointer, and touch input manager.
 * Supports injectable DOM targets via attach()/detach() or direct synthetic event handlers in tests.
 */
export class InputManager {
  private readonly dragSensitivity: number;
  private readonly tapMaxDurationMs: number;
  private readonly tapMaxMovePx: number;
  private readonly swipeJumpThresholdPx: number;
  private readonly swipeJumpMaxDurationMs: number;
  private readonly defaultViewportWidthPx: number;
  private readonly nowMs: () => number;

  private keyboardTarget: InputEventTarget | null = null;
  private pointerTarget: InputEventTarget | null = null;

  private leftHeld = false;
  private rightHeld = false;
  private jumpHeld = false;
  private brakeHeld = false;
  private touchBrakeHeld = false;

  private pendingJumpPressed = false;
  private pendingBlizzardToggle = false;
  private pendingDebugToggle = false;
  private pendingProfilerToggle = false;
  private pendingPauseToggle = false;
  private accumulatedDragPx = 0;
  private _hasSteered = false;

  private activeInputMode: 'none' | 'pointer' | 'touch' = 'none';
  private primaryPointerId: number | null = null;
  private readonly activePointers = new Map<number, ActivePointerTrack>();
  private readonly pointerTrackPool: ActivePointerTrack[] = [];
  private readonly tilt: TiltInputController;

  private readonly onKeyDownListener = (ev: unknown): void => {
    this.handleKeyDown(ev as KeyboardInputEvent);
  };
  private readonly onKeyUpListener = (ev: unknown): void => {
    this.handleKeyUp(ev as KeyboardInputEvent);
  };
  private readonly onBlurListener = (): void => {
    this.resetHeldInputs();
  };
  private readonly onPointerDownListener = (ev: unknown): void => {
    this.handlePointerDown(ev as PointerInputEvent);
  };
  private readonly onPointerMoveListener = (ev: unknown): void => {
    this.handlePointerMove(ev as PointerInputEvent);
  };
  private readonly onPointerUpListener = (ev: unknown): void => {
    this.handlePointerUp(ev as PointerInputEvent);
  };
  private readonly onPointerCancelListener = (ev: unknown): void => {
    this.handlePointerCancel(ev as PointerInputEvent);
  };
  private readonly onTouchStartListener = (ev: unknown): void => {
    this.handleTouchStart(ev as TouchInputEvent);
  };
  private readonly onTouchMoveListener = (ev: unknown): void => {
    this.handleTouchMove(ev as TouchInputEvent);
  };
  private readonly onTouchEndListener = (ev: unknown): void => {
    this.handleTouchEnd(ev as TouchInputEvent);
  };
  private readonly onTouchCancelListener = (ev: unknown): void => {
    this.handleTouchCancel(ev as TouchInputEvent);
  };

  constructor(options: InputManagerOptions = {}) {
    this.dragSensitivity = options.dragSensitivity ?? 1.0;
    this.tapMaxDurationMs = options.tapMaxDurationMs ?? 240;
    this.tapMaxMovePx = options.tapMaxMovePx ?? 12;
    this.swipeJumpThresholdPx = options.swipeJumpThresholdPx ?? 36;
    this.swipeJumpMaxDurationMs = options.swipeJumpMaxDurationMs ?? 220;
    this.defaultViewportWidthPx = options.defaultViewportWidthPx ?? 800;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.tilt = new TiltInputController({
      ...options.tilt,
      nowMs: options.tilt?.nowMs ?? this.nowMs,
    });
  }

  get isAttached(): boolean {
    return this.keyboardTarget !== null || this.pointerTarget !== null;
  }

  get hasSteered(): boolean {
    return this._hasSteered;
  }

  get tiltEnabled(): boolean {
    return this.tilt.enabled;
  }

  get tiltStatus(): TiltControlStatus {
    return this.tilt.status;
  }

  get tiltRequiresPermission(): boolean {
    return this.tilt.requiresExplicitPermission;
  }

  enableTilt(): Promise<TiltControlStatus> {
    return this.tilt.enable();
  }

  disableTilt(): void {
    this.tilt.disable();
  }

  resetHasSteered(): void {
    this._hasSteered = false;
  }

  handleDeviceOrientation(event: DeviceOrientationInputEvent): void {
    this.tilt.handleDeviceOrientation(event);
  }

  handleDeviceMotion(event: DeviceMotionInputEvent): void {
    this.tilt.handleDeviceMotion(event);
  }

  /**
   * Attaches DOM listeners to injectable targets (e.g., window + canvas).
   * Safe to omit in headless tests and drive via handleKeyDown/handlePointer* instead.
   */
  attach(
    keyboardTarget: InputEventTarget,
    pointerTarget: InputEventTarget = keyboardTarget,
    sensorHost: TiltPermissionHost = keyboardTarget as unknown as TiltPermissionHost,
  ): void {
    this.detach();
    this.keyboardTarget = keyboardTarget;
    this.pointerTarget = pointerTarget;
    this.tilt.attach(sensorHost);

    keyboardTarget.addEventListener('keydown', this.onKeyDownListener);
    keyboardTarget.addEventListener('keyup', this.onKeyUpListener);
    keyboardTarget.addEventListener('blur', this.onBlurListener);

    pointerTarget.addEventListener('pointerdown', this.onPointerDownListener);
    pointerTarget.addEventListener('pointermove', this.onPointerMoveListener);
    pointerTarget.addEventListener('pointerup', this.onPointerUpListener);
    pointerTarget.addEventListener('pointercancel', this.onPointerCancelListener);
    pointerTarget.addEventListener('touchstart', this.onTouchStartListener, { passive: true });
    pointerTarget.addEventListener('touchmove', this.onTouchMoveListener, { passive: true });
    pointerTarget.addEventListener('touchend', this.onTouchEndListener, { passive: true });
    pointerTarget.addEventListener('touchcancel', this.onTouchCancelListener, { passive: true });
  }

  detach(): void {
    this.tilt.detach();
    if (this.keyboardTarget) {
      this.keyboardTarget.removeEventListener('keydown', this.onKeyDownListener);
      this.keyboardTarget.removeEventListener('keyup', this.onKeyUpListener);
      this.keyboardTarget.removeEventListener('blur', this.onBlurListener);
      this.keyboardTarget = null;
    }
    if (this.pointerTarget) {
      this.pointerTarget.removeEventListener('pointerdown', this.onPointerDownListener);
      this.pointerTarget.removeEventListener('pointermove', this.onPointerMoveListener);
      this.pointerTarget.removeEventListener('pointerup', this.onPointerUpListener);
      this.pointerTarget.removeEventListener('pointercancel', this.onPointerCancelListener);
      this.pointerTarget.removeEventListener('touchstart', this.onTouchStartListener);
      this.pointerTarget.removeEventListener('touchmove', this.onTouchMoveListener);
      this.pointerTarget.removeEventListener('touchend', this.onTouchEndListener);
      this.pointerTarget.removeEventListener('touchcancel', this.onTouchCancelListener);
      this.pointerTarget = null;
    }
    this.resetAll();
  }

  resetHeldInputs(): void {
    this.leftHeld = false;
    this.rightHeld = false;
    this.jumpHeld = false;
    this.brakeHeld = false;
    this.touchBrakeHeld = false;
    this.activeInputMode = 'none';
    this.primaryPointerId = null;
    for (const track of this.activePointers.values()) {
      this.pointerTrackPool.push(track);
    }
    this.activePointers.clear();
    this.tilt.resetForTransition();
  }

  resetAll(): void {
    this.resetHeldInputs();
    this.pendingJumpPressed = false;
    this.pendingBlizzardToggle = false;
    this.pendingDebugToggle = false;
    this.pendingProfilerToggle = false;
    this.pendingPauseToggle = false;
    this.accumulatedDragPx = 0;
  }

  handleKeyDown(event: KeyboardInputEvent): void {
    const id = this.normalizeKeyIdentifier(event);
    switch (id) {
      case 'left':
        this.leftHeld = true;
        this._hasSteered = true;
        event.preventDefault?.();
        break;
      case 'right':
        this.rightHeld = true;
        this._hasSteered = true;
        event.preventDefault?.();
        break;
      case 'jump':
        if (!event.repeat && !this.jumpHeld) {
          this.pendingJumpPressed = true;
        }
        this.jumpHeld = true;
        event.preventDefault?.();
        break;
      case 'brake':
        this.brakeHeld = true;
        event.preventDefault?.();
        break;
      case 'blizzard':
        if (!event.repeat) this.pendingBlizzardToggle = true;
        break;
      case 'debug':
        if (!event.repeat) this.pendingDebugToggle = true;
        break;
      case 'profiler':
        if (!event.repeat) this.pendingProfilerToggle = true;
        break;
      case 'pause':
        if (!event.repeat) this.pendingPauseToggle = true;
        break;
      default:
        break;
    }
  }

  handleKeyUp(event: KeyboardInputEvent): void {
    const id = this.normalizeKeyIdentifier(event);
    switch (id) {
      case 'left':
        this.leftHeld = false;
        break;
      case 'right':
        this.rightHeld = false;
        break;
      case 'jump':
        this.jumpHeld = false;
        break;
      case 'brake':
        this.brakeHeld = false;
        break;
      default:
        break;
    }
  }

  handlePointerDown(event: PointerInputEvent): void {
    if (this.activeInputMode === 'touch') return;
    this.activeInputMode = 'pointer';
    this.beginTrack(
      event.pointerId ?? 0,
      event.clientX,
      event.clientY,
      Boolean(event.isPrimary),
    );
  }

  handlePointerMove(event: PointerInputEvent): void {
    if (this.activeInputMode !== 'pointer') return;
    this.moveTrack(event.pointerId ?? 0, event.clientX, event.clientY);
  }

  handlePointerUp(event: PointerInputEvent): void {
    if (this.activeInputMode !== 'pointer') return;
    this.endTrack(event.pointerId ?? 0);
  }

  handlePointerCancel(event: PointerInputEvent): void {
    if (this.activeInputMode !== 'pointer') return;
    this.cancelTrack(event.pointerId ?? 0);
  }

  handleTouchStart(event: TouchInputEvent): void {
    if (this.activeInputMode === 'pointer') return;
    const list = event.changedTouches ?? event.touches;
    if (list.length === 0) return;
    this.activeInputMode = 'touch';
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      this.beginTrack(
        t.identifier,
        t.clientX,
        t.clientY,
        i === 0 && this.primaryPointerId === null,
      );
    }
  }

  handleTouchMove(event: TouchInputEvent): void {
    if (this.activeInputMode !== 'touch') return;
    const list = event.changedTouches ?? event.touches;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      this.moveTrack(t.identifier, t.clientX, t.clientY);
    }
  }

  handleTouchEnd(event: TouchInputEvent): void {
    if (this.activeInputMode !== 'touch') return;
    const list = event.changedTouches ?? event.touches;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      this.endTrack(t.identifier);
    }
  }

  handleTouchCancel(event: TouchInputEvent): void {
    if (this.activeInputMode !== 'touch') return;
    const list = event.changedTouches ?? event.touches;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      this.cancelTrack(t.identifier);
    }
  }

  private beginTrack(trackId: number, clientX: number, clientY: number, isPrimary: boolean): void {
    const now = this.nowMs();
    let track = this.activePointers.get(trackId);
    if (!track) {
      track = this.pointerTrackPool.pop() ?? {
        startX: 0,
        startY: 0,
        lastX: 0,
        lastY: 0,
        startTimeMs: 0,
        movedDistPx: 0,
        swipeJumped: false,
      };
      this.activePointers.set(trackId, track);
    }

    track.startX = clientX;
    track.startY = clientY;
    track.lastX = clientX;
    track.lastY = clientY;
    track.startTimeMs = now;
    track.movedDistPx = 0;
    track.swipeJumped = false;

    if (this.primaryPointerId === null || isPrimary) {
      this.primaryPointerId = trackId;
    }
    this.touchBrakeHeld = this.activePointers.size >= 2;
  }

  private moveTrack(trackId: number, clientX: number, clientY: number): void {
    const track = this.activePointers.get(trackId);
    if (!track) return;

    const dx = clientX - track.lastX;
    const dy = clientY - track.lastY;
    track.lastX = clientX;
    track.lastY = clientY;
    track.movedDistPx += Math.hypot(dx, dy);

    if (trackId === this.primaryPointerId) {
      this.accumulatedDragPx += dx;
      if (Math.abs(clientX - track.startX) >= 4) {
        this._hasSteered = true;
      }

      const elapsed = this.nowMs() - track.startTimeMs;
      const totalDy = clientY - track.startY;
      if (
        !track.swipeJumped &&
        totalDy <= -this.swipeJumpThresholdPx &&
        elapsed <= this.swipeJumpMaxDurationMs
      ) {
        track.swipeJumped = true;
        this.pendingJumpPressed = true;
      }
    }
  }

  private endTrack(trackId: number): void {
    const track = this.activePointers.get(trackId);
    if (track) {
      const elapsed = this.nowMs() - track.startTimeMs;
      if (
        trackId === this.primaryPointerId &&
        !track.swipeJumped &&
        elapsed <= this.tapMaxDurationMs &&
        track.movedDistPx <= this.tapMaxMovePx
      ) {
        this.pendingJumpPressed = true;
      }
      this.activePointers.delete(trackId);
      this.pointerTrackPool.push(track);
    }

    if (trackId === this.primaryPointerId) {
      const next = this.activePointers.keys().next();
      this.primaryPointerId = next.done ? null : next.value;
    }
    this.touchBrakeHeld = this.activePointers.size >= 2;
    if (this.activePointers.size === 0) {
      this.activeInputMode = 'none';
    }
  }

  private cancelTrack(trackId: number): void {
    const track = this.activePointers.get(trackId);
    if (track) {
      this.activePointers.delete(trackId);
      this.pointerTrackPool.push(track);
    }
    if (trackId === this.primaryPointerId) {
      const next = this.activePointers.keys().next();
      this.primaryPointerId = next.done ? null : next.value;
    }
    this.touchBrakeHeld = this.activePointers.size >= 2;
    if (this.activePointers.size === 0) {
      this.activeInputMode = 'none';
    }
  }

  /**
   * Writes current held state and consumes edge-triggered actions + drag deltas into `out`.
   * Zero-allocation when `out` is reused across frames.
   * Pass `recordTiltSteer = false` while paused or in menus so idle tilting does not dismiss
   * the onboarding hint before the run starts.
   */
  sampleFrameInto(out: MutableInputFrameState, recordTiltSteer = true): InputFrameState {
    const keySteer = (this.rightHeld ? 1 : 0) - (this.leftHeld ? 1 : 0);
    const tiltSteer = this.tilt.sampleSteer();
    const tiltActive = this.tilt.isActivelySteering;
    const steer = keySteer !== 0 ? keySteer : tiltActive ? tiltSteer : 0;
    if (recordTiltSteer && tiltActive && Math.abs(tiltSteer) >= 0.12) {
      this._hasSteered = true;
    }

    const width = this.getViewportWidth();
    // Suppress accidental horizontal touch-drag jitter while live tilt steering is active;
    // tap-jump, swipe-up-jump, and 2-finger brake remain active.
    const dragPx = tiltActive ? 0 : this.accumulatedDragPx;
    const dragNorm = (dragPx / Math.max(1, width)) * this.dragSensitivity;

    out.steer = steer;
    out.dragDelta = dragNorm;
    out.dragDeltaPx = dragPx;
    out.jumpHeld = this.jumpHeld;
    out.jumpPressed = this.pendingJumpPressed;
    out.brakeHeld = this.brakeHeld || this.touchBrakeHeld;
    out.toggleBlizzardPressed = this.pendingBlizzardToggle;
    out.toggleDebugPressed = this.pendingDebugToggle;
    out.toggleProfilerPressed = this.pendingProfilerToggle;
    out.togglePausePressed = this.pendingPauseToggle;
    out.hasSteered = this._hasSteered;

    this.accumulatedDragPx = 0;
    this.pendingJumpPressed = false;
    this.pendingBlizzardToggle = false;
    this.pendingDebugToggle = false;
    this.pendingProfilerToggle = false;
    this.pendingPauseToggle = false;

    return out;
  }

  private getViewportWidth(): number {
    if (this.pointerTarget?.clientWidth && this.pointerTarget.clientWidth > 0) {
      return this.pointerTarget.clientWidth;
    }
    if (this.pointerTarget?.innerWidth && this.pointerTarget.innerWidth > 0) {
      return this.pointerTarget.innerWidth;
    }
    if (this.keyboardTarget?.clientWidth && this.keyboardTarget.clientWidth > 0) {
      return this.keyboardTarget.clientWidth;
    }
    if (this.keyboardTarget?.innerWidth && this.keyboardTarget.innerWidth > 0) {
      return this.keyboardTarget.innerWidth;
    }
    return this.defaultViewportWidthPx;
  }

  private normalizeKeyIdentifier(
    event: KeyboardInputEvent,
  ): 'left' | 'right' | 'jump' | 'brake' | 'blizzard' | 'debug' | 'profiler' | 'pause' | null {
    const code = event.code;
    if (code) {
      switch (code) {
        case 'KeyA':
        case 'ArrowLeft':
          return 'left';
        case 'KeyD':
        case 'ArrowRight':
          return 'right';
        case 'Space':
        case 'KeyW':
        case 'ArrowUp':
          return 'jump';
        case 'KeyS':
        case 'ArrowDown':
          return 'brake';
        case 'KeyB':
          return 'blizzard';
        case 'KeyG':
          return 'debug';
        case 'KeyP':
          return 'profiler';
        case 'Escape':
          return 'pause';
        default:
          break;
      }
    }

    const key = event.key?.toLowerCase();
    switch (key) {
      case 'a':
      case 'arrowleft':
        return 'left';
      case 'd':
      case 'arrowright':
        return 'right';
      case ' ':
      case 'spacebar':
      case 'w':
      case 'arrowup':
        return 'jump';
      case 's':
      case 'arrowdown':
        return 'brake';
      case 'b':
        return 'blizzard';
      case 'g':
        return 'debug';
      case 'p':
        return 'profiler';
      case 'escape':
        return 'pause';
      default:
        return null;
    }
  }
}
