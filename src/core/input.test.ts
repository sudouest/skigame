import { describe, expect, it } from 'vitest';
import { InputManager, createInputFrameState, type InputEventTarget } from './input';
import type { TiltPermissionHost } from './tiltInput';

class MockDomTarget implements InputEventTarget {
  readonly clientWidth = 1000;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

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

  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class MockSensorWindow extends MockDomTarget implements TiltPermissionHost {
  isSecureContext = true;
  orientation = 0;
  navigator = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' };
  DeviceOrientationEvent = {};
  DeviceMotionEvent = {};
}

describe('InputManager', () => {
  it('handles keyboard steering, jump, brake, edge toggles, repeat guard, and blur reset', () => {
    const input = new InputManager();
    const state = createInputFrameState();

    input.handleKeyDown({ code: 'KeyA' });
    input.handleKeyDown({ code: 'Space' });
    input.handleKeyDown({ code: 'KeyB' });
    input.handleKeyDown({ code: 'KeyG' });
    input.handleKeyDown({ code: 'KeyP' });
    input.handleKeyDown({ code: 'Escape' });
    input.handleKeyDown({ code: 'KeyS' });

    input.sampleFrameInto(state);
    expect(state.steer).toBe(-1);
    expect(state.jumpHeld).toBe(true);
    expect(state.jumpPressed).toBe(true);
    expect(state.brakeHeld).toBe(true);
    expect(state.toggleBlizzardPressed).toBe(true);
    expect(state.toggleDebugPressed).toBe(true);
    expect(state.toggleProfilerPressed).toBe(true);
    expect(state.togglePausePressed).toBe(true);
    expect(state.hasSteered).toBe(true);

    // Repeat presses should not re-trigger edge toggles
    input.handleKeyDown({ code: 'KeyB', repeat: true });
    input.handleKeyDown({ code: 'Space', repeat: true });
    input.sampleFrameInto(state);
    expect(state.jumpPressed).toBe(false);
    expect(state.toggleBlizzardPressed).toBe(false);
    expect(state.steer).toBe(-1);

    input.handleKeyUp({ code: 'KeyA' });
    input.handleKeyDown({ code: 'ArrowRight' });
    input.sampleFrameInto(state);
    expect(state.steer).toBe(1);

    input.resetHeldInputs();
    input.sampleFrameInto(state);
    expect(state.steer).toBe(0);
    expect(state.brakeHeld).toBe(false);
    expect(state.jumpHeld).toBe(false);
  });

  it('supports injectable DOM attachment, relative horizontal drag, tap jump, and 2-finger brake', () => {
    let now = 1000;
    const keyboardTarget = new MockDomTarget();
    const pointerTarget = new MockDomTarget();
    const input = new InputManager({
      dragSensitivity: 1.0,
      nowMs: () => now,
    });
    const state = createInputFrameState();

    input.attach(keyboardTarget, pointerTarget);
    expect(input.isAttached).toBe(true);
    expect(keyboardTarget.listenerCount('keydown')).toBe(1);
    expect(pointerTarget.listenerCount('pointerdown')).toBe(1);

    // Relative drag of +100px on 1000px viewport -> dragDelta = 0.1
    pointerTarget.dispatch('pointerdown', { pointerId: 1, clientX: 400, clientY: 500, isPrimary: true });
    now += 30;
    pointerTarget.dispatch('pointermove', { pointerId: 1, clientX: 500, clientY: 502 });
    input.sampleFrameInto(state);
    expect(state.dragDeltaPx).toBe(100);
    expect(state.dragDelta).toBeCloseTo(0.1, 6);
    expect(state.hasSteered).toBe(true);

    // Drag accumulator resets after sampleInto
    input.sampleFrameInto(state);
    expect(state.dragDeltaPx).toBe(0);

    // Second finger activates touch brake
    pointerTarget.dispatch('pointerdown', { pointerId: 2, clientX: 200, clientY: 500 });
    input.sampleFrameInto(state);
    expect(state.brakeHeld).toBe(true);

    pointerTarget.dispatch('pointerup', { pointerId: 2, clientX: 200, clientY: 500 });
    pointerTarget.dispatch('pointerup', { pointerId: 1, clientX: 500, clientY: 502 });
    input.sampleFrameInto(state);
    expect(state.brakeHeld).toBe(false);
    expect(state.jumpPressed).toBe(false); // moved 100px so not a tap

    // Quick tap triggers jumpPressed
    pointerTarget.dispatch('pointerdown', { pointerId: 3, clientX: 300, clientY: 300, isPrimary: true });
    now += 80;
    pointerTarget.dispatch('pointerup', { pointerId: 3, clientX: 302, clientY: 301 });
    input.sampleFrameInto(state);
    expect(state.jumpPressed).toBe(true);

    // Quick swipe-up triggers jumpPressed
    pointerTarget.dispatch('pointerdown', { pointerId: 4, clientX: 300, clientY: 300, isPrimary: true });
    now += 50;
    pointerTarget.dispatch('pointermove', { pointerId: 4, clientX: 302, clientY: 250 });
    pointerTarget.dispatch('pointerup', { pointerId: 4, clientX: 302, clientY: 250 });
    input.sampleFrameInto(state);
    expect(state.jumpPressed).toBe(true);

    // Touch cancel must not trigger tap jump
    input.handleTouchStart({
      touches: [{ identifier: 1, clientX: 200, clientY: 200 }],
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 200 }],
    });
    now += 30;
    input.handleTouchCancel({
      touches: [],
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 200 }],
    });
    input.sampleFrameInto(state);
    expect(state.jumpPressed).toBe(false);

    // High pointerId (>= 100000) works cleanly and suppresses duplicate touch events
    pointerTarget.dispatch('pointerdown', { pointerId: 150000, clientX: 400, clientY: 400, isPrimary: true });
    input.handleTouchStart({
      touches: [{ identifier: 150000, clientX: 400, clientY: 400 }],
      changedTouches: [{ identifier: 150000, clientX: 400, clientY: 400 }],
    });
    pointerTarget.dispatch('pointermove', { pointerId: 150000, clientX: 460, clientY: 400 });
    input.handleTouchMove({
      touches: [{ identifier: 150000, clientX: 460, clientY: 400 }],
      changedTouches: [{ identifier: 150000, clientX: 460, clientY: 400 }],
    });
    input.sampleFrameInto(state);
    expect(state.dragDeltaPx).toBe(60); // Not double-counted to 120
    expect(state.brakeHeld).toBe(false); // Not treated as 2nd finger
    pointerTarget.dispatch('pointerup', { pointerId: 150000, clientX: 460, clientY: 400 });

    input.detach();
    expect(input.isAttached).toBe(false);
    expect(keyboardTarget.listenerCount('keydown')).toBe(0);
    expect(pointerTarget.listenerCount('pointerdown')).toBe(0);
  });

  it('integrates tilt steering with keyboard override, drag suppression during active tilt, and tap/brake retention', async () => {
    let now = 2000;
    const sensorWindow = new MockSensorWindow();
    const pointerTarget = new MockDomTarget();
    const input = new InputManager({
      dragSensitivity: 1.0,
      nowMs: () => now,
      tilt: { noSensorTimeoutMs: 1200 },
    });
    const state = createInputFrameState();

    input.attach(sensorWindow, pointerTarget);
    expect(input.tiltStatus).toBe('inactive');

    await input.enableTilt();
    expect(input.tiltEnabled).toBe(true);
    expect(input.tiltStatus).toBe('waiting');

    // While waiting (not yet active), horizontal touch drag still works as fallback
    pointerTarget.dispatch('pointerdown', { pointerId: 1, clientX: 400, clientY: 500, isPrimary: true });
    pointerTarget.dispatch('pointermove', { pointerId: 1, clientX: 450, clientY: 500 });
    input.sampleFrameInto(state);
    expect(state.dragDeltaPx).toBe(50);
    pointerTarget.dispatch('pointerup', { pointerId: 1, clientX: 450, clientY: 500 });

    // Deliver initial neutral sample -> active, then tilt right
    sensorWindow.dispatch('deviceorientation', { alpha: 0, beta: 30, gamma: 0 });
    now += 200;
    sensorWindow.dispatch('deviceorientation', { alpha: 0, beta: 30, gamma: 24 });

    // Accidental drag is suppressed while tilt is active, but tap-jump & 2-finger brake still work
    pointerTarget.dispatch('pointerdown', { pointerId: 2, clientX: 300, clientY: 300, isPrimary: true });
    pointerTarget.dispatch('pointermove', { pointerId: 2, clientX: 380, clientY: 300 });
    pointerTarget.dispatch('pointerdown', { pointerId: 3, clientX: 200, clientY: 300 });
    input.sampleFrameInto(state);
    expect(input.tiltStatus).toBe('active');
    expect(state.steer).toBeGreaterThan(0.5);
    expect(state.hasSteered).toBe(true);
    expect(state.dragDeltaPx).toBe(0);
    expect(state.brakeHeld).toBe(true);
    pointerTarget.dispatch('pointerup', { pointerId: 3, clientX: 200, clientY: 300 });
    pointerTarget.dispatch('pointerup', { pointerId: 2, clientX: 380, clientY: 300 });

    // Quick tap still triggers jump while tilt is active
    pointerTarget.dispatch('pointerdown', { pointerId: 4, clientX: 300, clientY: 300, isPrimary: true });
    now += 60;
    pointerTarget.dispatch('pointerup', { pointerId: 4, clientX: 301, clientY: 300 });
    input.sampleFrameInto(state);
    expect(state.jumpPressed).toBe(true);

    // Keyboard input overrides tilt cleanly
    input.handleKeyDown({ code: 'KeyA' });
    input.sampleFrameInto(state);
    expect(state.steer).toBe(-1);
    input.handleKeyUp({ code: 'KeyA' });

    // DeviceMotion fallback & resetAll() keep tilt enabled, and menu sampling does not latch hasSteered
    input.handleDeviceMotion({ accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 } });
    input.resetAll();
    expect(input.tiltEnabled).toBe(true);
    input.sampleFrameInto(state);
    expect(state.steer).toBe(0);

    input.resetHasSteered();
    now += 200;
    sensorWindow.dispatch('deviceorientation', { alpha: 0, beta: 0, gamma: 24 });
    input.sampleFrameInto(state, false);
    expect(state.hasSteered).toBe(false);

    // Timeout to no-sensor restores touch drag fallback
    input.disableTilt();
    await input.enableTilt();
    now += 1500;
    input.sampleFrameInto(state);
    expect(input.tiltStatus).toBe('no-sensor');
    pointerTarget.dispatch('pointerdown', { pointerId: 5, clientX: 300, clientY: 500, isPrimary: true });
    pointerTarget.dispatch('pointermove', { pointerId: 5, clientX: 345, clientY: 500 });
    input.sampleFrameInto(state);
    expect(state.dragDeltaPx).toBe(45);
    pointerTarget.dispatch('pointerup', { pointerId: 5, clientX: 345, clientY: 500 });

    input.detach();
    expect(input.tiltEnabled).toBe(false);
    expect(sensorWindow.listenerCount('deviceorientation')).toBe(0);
  });
});
