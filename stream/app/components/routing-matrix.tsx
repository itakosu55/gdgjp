import { SetupForm } from "~/components/setup-form";
import type { DeviceModel } from "~/lib/av/types";
import type { NodeInfo } from "~/lib/setup-view";

/**
 * A device's (input × bus) matrix, as a grid of booleans.
 *
 * A cell says only "does this input reach that bus". There is no gain, EQ, pan
 * or fader anywhere in the model, deliberately: cycle detection never needs a dB
 * value, and the omission is what keeps the data maintainable during a live
 * event. Every cell posts on its own, so a mis-click is one click to undo.
 */
export function RoutingMatrix({
  info,
  model,
  enabled,
}: {
  info: NodeInfo;
  model: DeviceModel;
  /** `${nodeId}::${inPort}::${bus}` for every enabled cell. */
  enabled: ReadonlySet<string>;
}) {
  const inputs = model.ports.filter((port) => port.direction === "in");
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">入力</th>
            {model.buses.map((bus) => (
              <th key={bus.key} className="px-3 py-2 text-center">
                {bus.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {inputs.map((port) => (
            <tr key={port.key} className="border-t">
              <td className="px-3 py-2 whitespace-nowrap">{port.label}</td>
              {model.buses.map((bus) => {
                const on = enabled.has(`${info.node.id}::${port.key}::${bus.key}`);
                return (
                  <td key={bus.key} className="px-3 py-2 text-center">
                    <SetupForm>
                      <input type="hidden" name="intent" value="toggle-route" />
                      <input type="hidden" name="nodeId" value={info.node.id} />
                      <input type="hidden" name="inPort" value={port.key} />
                      <input type="hidden" name="bus" value={bus.key} />
                      <button
                        type="submit"
                        aria-label={`${port.label} → ${bus.label}`}
                        aria-pressed={on}
                        className={
                          on
                            ? "size-5 rounded border border-primary bg-primary text-xs text-primary-foreground"
                            : "size-5 rounded border border-input text-xs text-muted-foreground hover:border-ring"
                        }
                      >
                        {on ? "✓" : ""}
                      </button>
                    </SetupForm>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function hasMatrix(info: NodeInfo): boolean {
  return info.model?.internalRouting === "matrix" && info.model.buses.length > 0;
}
