import { useEffect, useMemo, useState } from "react";

import {
  GetBehaviorDetailsResponse,
  BehaviorBindingParametersSet,
} from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import { BehaviorBinding } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { BehaviorParametersPicker } from "./BehaviorParametersPicker";
import { validateValue } from "./parameters";

export interface BehaviorBindingPickerProps {
  binding: BehaviorBinding;
  behaviors: GetBehaviorDetailsResponse[];
  layers: { id: number; name: string }[];
  onBindingChanged: (binding: BehaviorBinding) => void;
}

function validateBinding(
  metadata: BehaviorBindingParametersSet[],
  layerIds: number[],
  param1?: number,
  param2?: number
): boolean {
  if (
    (param1 === undefined || param1 === 0) &&
    metadata.every((s) => !s.param1 || s.param1.length === 0)
  ) {
    return true;
  }

  let matchingSet = metadata.find((s) =>
    validateValue(layerIds, param1, s.param1)
  );

  if (!matchingSet) {
    return false;
  }

  return validateValue(layerIds, param2, matchingSet.param2);
}

const BEHAVIOR_PRIORITY: string[] = [
  "Key Press",
  "Mod Tap",
  "Layer Tap",
  "Momentary Layer",
  "Toggle Layer",
  "Sticky Key",
  "Bluetooth",
  "Output Selection",
  "Transparent",
  "None",
  "Studio Unlock",
  "Bootloader",
  "External Power",
  "Grave/Escape",
  "Key Repeat",
  "Key Toggle",
];

const BEHAVIOR_DESCRIPTIONS: Record<string, string> = {
  "Key Press": "キーコードを送信します",
  "Mod Tap": "ホールド: modifier / タップ: キーコードを送信",
  "Layer Tap": "ホールド: レイヤー有効化 / タップ: キーコードを送信",
  "Momentary Layer": "押している間、指定レイヤーを有効化",
  "Toggle Layer": "レイヤーのオン/オフを切り替え",
  "Sticky Key": "次のキー入力に modifier を付与",
  "Bluetooth": "Bluetooth 接続を制御",
  "Output Selection": "USB / BLE 出力先を切り替え",
  "Transparent": "下位レイヤーの binding をそのまま使用",
  "None": "何もしません",
  "Studio Unlock": "ZMK Studio のロックを解除",
  "Bootloader": "ブートローダーモードに入ります",
  "External Power": "外部電源を制御",
  "Grave/Escape": "Shift/GUI なし: Grave、あり: Escape",
  "Key Repeat": "直前のキーコードを繰り返し送信",
  "Key Toggle": "キーコードのトグル",
};

export const BehaviorBindingPicker = ({
  binding,
  layers,
  behaviors,
  onBindingChanged,
}: BehaviorBindingPickerProps) => {
  const [behaviorId, setBehaviorId] = useState(binding.behaviorId);
  const [param1, setParam1] = useState<number | undefined>(binding.param1);
  const [param2, setParam2] = useState<number | undefined>(binding.param2);

  const metadata = useMemo(
    () => behaviors.find((b) => b.id == behaviorId)?.metadata,
    [behaviorId, behaviors]
  );

  const selectedBehavior = useMemo(
    () => behaviors.find((b) => b.id === behaviorId),
    [behaviors, behaviorId]
  );

  const orderedBehaviors = useMemo(
    () =>
      [...behaviors].sort((a, b) => {
        const ai = BEHAVIOR_PRIORITY.indexOf(a.displayName);
        const bi = BEHAVIOR_PRIORITY.indexOf(b.displayName);
        if (ai === -1 && bi === -1) return a.displayName.localeCompare(b.displayName);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      }),
    [behaviors]
  );

  useEffect(() => {
    if (
      binding.behaviorId === behaviorId &&
      binding.param1 === param1 &&
      binding.param2 === param2
    ) {
      return;
    }

    if (!metadata) {
      console.error(
        "Can't find metadata for the selected behaviorId",
        behaviorId
      );
      return;
    }

    if (
      validateBinding(
        metadata,
        layers.map(({ id }) => id),
        param1,
        param2
      )
    ) {
      onBindingChanged({
        behaviorId,
        param1: param1 || 0,
        param2: param2 || 0,
      });
    }
  }, [behaviorId, param1, param2]);

  useEffect(() => {
    setBehaviorId(binding.behaviorId);
    setParam1(binding.param1);
    setParam2(binding.param2);
  }, [binding]);

  return (
    <div className="flex h-full overflow-hidden divide-x divide-base-300">
      {/* Left pane: behavior list */}
      <div className="w-48 shrink-0 flex flex-col overflow-hidden">
        <div className="px-3 py-2 text-base font-semibold text-base-content shrink-0 border-b border-base-300">
          Behavior
        </div>
        <div className="flex-1 overflow-y-auto">
          {orderedBehaviors.map((b) => (
            <label
              key={b.id}
              className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm transition-colors ${
                behaviorId === b.id
                  ? "bg-primary text-primary-content"
                  : "hover:bg-base-100 text-base-content"
              }`}
            >
              <input
                type="radio"
                name="behavior-picker"
                value={b.id}
                checked={behaviorId === b.id}
                onChange={() => {
                  setBehaviorId(b.id);
                  setParam1(0);
                  setParam2(0);
                }}
                className="shrink-0 accent-primary"
              />
              {b.displayName}
            </label>
          ))}
        </div>
      </div>

      {/* Right pane: header + parameters */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2.5 border-b border-base-300 shrink-0">
          <div className="font-semibold text-base">{selectedBehavior?.displayName ?? "—"}</div>
          {selectedBehavior && (
            <div className="text-sm text-base-content/50 mt-0.5">
              {BEHAVIOR_DESCRIPTIONS[selectedBehavior.displayName] ?? ""}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {metadata && (
            <BehaviorParametersPicker
              metadata={metadata}
              param1={param1}
              param2={param2}
              layers={layers}
              onParam1Changed={setParam1}
              onParam2Changed={setParam2}
            />
          )}
        </div>
      </div>
    </div>
  );
};
