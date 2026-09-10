import { describe, expect, test } from "bun:test";
import { runHost, runWorker } from "./harness.ts";

function pad(overrides: Record<string, any> = {}) {
  return {
    index: 0,
    id: "Xbox Wireless Controller",
    mapping: "standard",
    connected: true,
    timestamp: 12.5,
    axes: [0, -0.5, 0.25, 0],
    buttons: [
      { value: 1, pressed: true, touched: true },
      { value: 0, pressed: false, touched: false },
    ],
    vibrationActuator: {
      effects: [] as any[],
      playEffect(type: string, params: any) {
        this.effects.push({ type, params });
      },
    },
    ...overrides,
  };
}

function messages(worker: any) {
  return worker.posted.map((item: any) => item.data);
}

describe("gamepads", () => {
  test("the page polls the pad and the worker answers KNI's poll from it", () => {
    const pads: any[] = [];
    const host = runHost({ gamepads: pads });
    host.readyListeners[0]?.();
    const worker = host.workers[0];

    // Nothing plugged in posts nothing.
    host.scheduled.shift()?.();
    expect(messages(worker).some((data: any) => data.type === "gamepads")).toBe(false);

    pads.push(pad());
    host.scheduled.shift()?.();

    // The snapshot has to precede the connect event: KNI answers the event by
    // reading the pad back out of the API it thinks it is talking to.
    const labels = messages(worker).map((data: any) => (data.name ? data.type + ":" + data.name : data.type));
    expect(labels.slice(-2)).toEqual(["gamepads", "event:gamepadconnected"]);
    const connect = messages(worker).pop();
    expect(connect.gamepadIndex).toBe(0);

    const snapshot = messages(worker).find((data: any) => data.type === "gamepads");
    const runtime = runWorker();
    runtime.context.onmessage({ data: snapshot });

    const list = runtime.context.navigator.getGamepads();
    // Absent pads are holes the interop reads by index, so they must be null.
    expect(list).toHaveLength(4);
    expect(list[1]).toBeNull();
    expect(list[0].id).toBe("Xbox Wireless Controller");
    expect(list[0].mapping).toBe("standard");
    expect(list[0].connected).toBe(true);
    expect(list[0].axes).toEqual([0, -0.5, 0.25, 0]);
    expect(list[0].buttons).toEqual([
      { value: 1, pressed: true, touched: true },
      { value: 0, pressed: false, touched: false },
    ]);
  });

  test("the pad object survives the next poll so its interop uid does", () => {
    const pads: any[] = [pad()];
    const host = runHost({ gamepads: pads });
    host.readyListeners[0]?.();
    host.scheduled.shift()?.();
    const runtime = runWorker();
    const snapshots = messages(host.workers[0]).filter((data: any) => data.type === "gamepads");
    runtime.context.onmessage({ data: snapshots[0] });
    const first = runtime.context.navigator.getGamepads()[0];

    pads[0].buttons[1] = { value: 0.5, pressed: true, touched: false };
    host.scheduled.shift()?.();
    const next = messages(host.workers[0]).filter((data: any) => data.type === "gamepads").pop();
    runtime.context.onmessage({ data: next });

    const second = runtime.context.navigator.getGamepads()[0];
    expect(second).toBe(first);
    expect(second.buttons[1]).toEqual({ value: 0.5, pressed: true, touched: false });
  });

  test("unplugging clears the pad and announces the disconnect", () => {
    const pads: any[] = [pad()];
    const host = runHost({ gamepads: pads });
    host.readyListeners[0]?.();
    host.scheduled.shift()?.();
    const runtime = runWorker();
    runtime.context.onmessage({
      data: messages(host.workers[0]).filter((data: any) => data.type === "gamepads").pop(),
    });

    pads.length = 0;
    host.scheduled.shift()?.();
    const tail = messages(host.workers[0]).slice(-2);
    expect(tail[0].type).toBe("gamepads");
    expect(tail[0].pads).toEqual([]);
    expect(tail[1].name).toBe("gamepaddisconnected");
    expect(tail[1].gamepadIndex).toBe(0);

    runtime.context.onmessage({ data: tail[0] });
    expect(runtime.context.navigator.getGamepads()).toEqual([null, null, null, null]);
  });

  test("rumble crosses back to the page, which owns the real actuator", () => {
    const pads: any[] = [pad()];
    const host = runHost({ gamepads: pads });
    host.readyListeners[0]?.();
    host.scheduled.shift()?.();
    const runtime = runWorker();
    runtime.context.onmessage({
      data: messages(host.workers[0]).filter((data: any) => data.type === "gamepads").pop(),
    });

    const actuator = runtime.context.navigator.getGamepads()[0].vibrationActuator;
    // This pad reports playEffect and no pulse, and the stand-in offers the
    // same pair - KNI takes whichever it finds first.
    expect(typeof actuator.pulse).toBe("undefined");
    expect(actuator.playEffect("dual-rumble", { duration: 500, strongMagnitude: 0.4 })).toBe(true);

    const command = runtime.posted.pop();
    expect(command.type).toBe("gamepad-vibrate");
    host.workers[0].onmessage({ data: command });
    expect(pads[0].vibrationActuator.effects).toEqual([
      { type: "dual-rumble", params: { duration: 500, strongMagnitude: 0.4 } },
    ]);
  });
});
