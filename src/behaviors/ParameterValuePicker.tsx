import { BehaviorParameterValueDescription } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import { HidUsagePicker } from "./HidUsagePicker";

export interface ParameterValuePickerProps {
  value?: number;
  values: BehaviorParameterValueDescription[];
  layers: { id: number; name: string }[];
  onValueChanged: (value?: number) => void;
}

const BTN =
  "px-3 py-1.5 text-sm rounded border transition-colors text-center leading-none";
const BTN_OFF =
  "bg-base-100 text-base-content border-base-300 hover:border-primary hover:bg-base-200";
const BTN_ON =
  "bg-primary text-primary-content border-primary shadow";

export const ParameterValuePicker = ({
  value,
  values,
  layers,
  onValueChanged,
}: ParameterValuePickerProps) => {
  if (values.length === 0) {
    return <></>;
  }

  // All constants → button grid
  if (values.every((v) => v.constant !== undefined)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <button
            key={v.constant}
            className={`${BTN} ${value === v.constant ? BTN_ON : BTN_OFF}`}
            onClick={() => onValueChanged(v.constant)}
          >
            {v.name}
          </button>
        ))}
      </div>
    );
  }

  if (values.length === 1) {
    // Range → number input
    if (values[0].range) {
      return (
        <div className="flex items-center gap-2">
          <label className="text-sm text-base-content/70">{values[0].name}</label>
          <input
            type="number"
            min={values[0].range.min}
            max={values[0].range.max}
            value={value ?? ""}
            className="w-24 px-2 py-1 text-sm rounded border border-base-300 bg-base-100"
            onChange={(e) => onValueChanged(parseInt(e.target.value))}
          />
        </div>
      );
    }

    // HID Usage → grid picker (defined in HidUsagePicker)
    if (values[0].hidUsage) {
      return (
        <HidUsagePicker
          onValueChanged={onValueChanged}
          label={values[0].name}
          value={value}
          usagePages={[
            { id: 7, min: 4, max: values[0].hidUsage.keyboardMax },
            { id: 12, max: values[0].hidUsage.consumerMax },
          ]}
        />
      );
    }

    // Layer ID → button per layer
    if (values[0].layerId) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {layers.map(({ name, id }) => (
            <button
              key={id}
              className={`${BTN} ${value === id ? BTN_ON : BTN_OFF}`}
              onClick={() => onValueChanged(id)}
            >
              {name}
            </button>
          ))}
        </div>
      );
    }
  }

  return <></>;
};
