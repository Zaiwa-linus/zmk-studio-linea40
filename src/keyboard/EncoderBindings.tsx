import { RotateCw } from "lucide-react";
import { useMemo } from "react";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type { BehaviorBinding } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import BehaviorShortNames from "./behavior-short-names.json";

interface BehaviorShortName { short?: string }
const shortNames: Record<string, BehaviorShortName> = BehaviorShortNames;

function shortenLabel(label: string): string {
  if (typeof shortNames[label]?.short !== "undefined") return shortNames[label].short as string;
  if (label.length > 9) {
    const words = label.split(/[\s,-]+/);
    const n = Math.trunc(9 / words.length);
    return words.map((w) => w.substring(0, n)).join("");
  }
  return label;
}

interface EncoderKeyProps {
  binding: BehaviorBinding | null;
  behaviors: Record<number, GetBehaviorDetailsResponse>;
  selected: boolean;
  changed?: boolean;
  onClick: () => void;
}

export function EncoderKey({ binding, behaviors, selected, changed, onClick }: EncoderKeyProps) {
  const behavior = binding != null ? behaviors[binding.behaviorId] : undefined;

  const bodyLabel = useMemo(() => {
    if (!behavior) return "—";
    const name = behavior.displayName ?? "";
    return shortenLabel(name);
  }, [behavior]);

  return (
    <button
      title="ロータリーエンコーダー"
      className={`relative group rounded-full flex flex-col cursor-pointer transition-all shadow-md ring-1 hover:shadow-xl hover:ring-2 hover:scale-105 ${
        selected ? "bg-primary text-primary-content" : "bg-base-100 text-base-content"
      }`}
      style={{ width: "92px", height: "92px" }}
      onClick={onClick}
    >
      {changed && (
        <span className="absolute bottom-0.5 right-0.5 w-2 h-2 rounded-full bg-purple-500 z-50 pointer-events-none" />
      )}
      <div
        className={`text-[9px] font-light opacity-70 w-full px-0.5 pt-0.5 leading-none truncate text-center flex items-center justify-center gap-0.5 ${
          selected ? "text-primary-content" : "text-base-content"
        }`}
      >
        <RotateCw size={8} />
      </div>
      <div className="flex-1 flex items-center justify-center w-full overflow-hidden px-1 pb-1 text-[10px] leading-none text-center whitespace-normal break-words [overflow-wrap:anywhere]">
        {bodyLabel}
      </div>
    </button>
  );
}

interface EncoderBindingPickerProps {
  binding: BehaviorBinding | null;
  behaviors: Record<number, GetBehaviorDetailsResponse>;
  presets: BehaviorBinding[];
  onBindingChanged: (binding: BehaviorBinding) => void;
}

function sameBinding(a: BehaviorBinding | null, b: BehaviorBinding): boolean {
  if (a === null) return false;
  return (
    a.behaviorId === b.behaviorId &&
    (a.param1 ?? 0) === (b.param1 ?? 0) &&
    (a.param2 ?? 0) === (b.param2 ?? 0)
  );
}

function bindingLabel(
  binding: BehaviorBinding,
  behaviors: Record<number, GetBehaviorDetailsResponse>,
): string {
  const behavior = behaviors[binding.behaviorId];
  const behaviorName = behavior?.displayName
    ? shortenLabel(behavior.displayName)
    : `#${binding.behaviorId}`;
  return `${behaviorName} ${binding.param1 ?? 0}/${binding.param2 ?? 0}`;
}

export function EncoderBindingPicker({
  binding,
  behaviors,
  presets,
  onBindingChanged,
}: EncoderBindingPickerProps) {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-base-200">
      <div className="px-4 py-2.5 border-b border-base-300 shrink-0">
        <div className="font-semibold text-base">Encoder</div>
        <div className="text-sm text-base-content/50 mt-0.5">
          センサー用の割り当てだけを選択できます。
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {presets.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {presets.map((preset) => {
              const selected = sameBinding(binding, preset);
              return (
                <button
                  key={`${preset.behaviorId}:${preset.param1 ?? 0}:${preset.param2 ?? 0}`}
                  type="button"
                  disabled={selected}
                  onClick={() => onBindingChanged(preset)}
                  className={`rounded px-3 py-2 text-left text-sm border transition-colors ${
                    selected
                      ? "bg-primary text-primary-content border-primary"
                      : "bg-base-100 hover:bg-base-300 border-base-300"
                  }`}
                >
                  {bindingLabel(preset, behaviors)}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-base-content/60">
            エンコーダー用の割り当て候補を取得できませんでした。
          </div>
        )}
      </div>
    </div>
  );
}
