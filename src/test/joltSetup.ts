import initJolt from 'jolt-physics/wasm';
import {
  JoltRuntime,
  resolveDefaultPhysicsRuntime,
  setDefaultPhysicsRuntime,
  type JoltModule,
} from '../sim/physics/joltRuntime';

if (!resolveDefaultPhysicsRuntime()) {
  const jolt = (await initJolt()) as unknown as JoltModule;
  setDefaultPhysicsRuntime(new JoltRuntime(jolt));
}
