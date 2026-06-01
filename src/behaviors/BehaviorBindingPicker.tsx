import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";

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
  savedBinding?: BehaviorBinding;
  onBindingChanged: (binding: BehaviorBinding) => void;
  onRevert?: () => void;
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

// Maps firmware-provided displayName to UI label (avoids vendor trademark issues)
const BEHAVIOR_NAME_OVERRIDES: Record<string, string> = {
  "Bluetooth": "Wireless",
  bt_layer: "Wireless Layer",
  bt_base: "Wireless Base",
};

const behaviorLabel = (firmwareName: string): string =>
  BEHAVIOR_NAME_OVERRIDES[firmwareName] ?? firmwareName;

const BEHAVIOR_PRIORITY: string[] = [
  "Key Press",
  "Mod Tap",
  "Layer Tap",
  "Momentary Layer",
  "Toggle Layer",
  "Sticky Key",
  "Wireless",
  "Wireless Layer",
  "Wireless Base",
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
  "Key Press":
    "キーを押したときに指定したキーコードを送信します。最もシンプルな割り当て。通常キー・修飾キー（Shift, Ctrl, Alt, GUI）・メディアキーなども選べます。",
  "Mod Tap":
    "タップ（短押し）: 通常キー送信 / ホールド（長押し）: 修飾キー（Shift, Ctrl, Alt, GUI）として動作。例: ホームポジション（A/S/D/F）に各修飾キーを割り当てる「ホームロウモッド」に活用できます。",
  "Layer Tap":
    "タップ（短押し）: キーコード送信 / ホールド（長押し）: 指定レイヤーを一時有効化（&mo と同等）。例: スペースに LT(MOUSE, Space) を設定→タップでスペース、ホールドで MOUSE レイヤー。",
  "Momentary Layer":
    "押している間だけ指定レイヤーを有効化します。離すと直前のレイヤーに戻ります。レイヤー切替キーの基本形。複数同時押しすると番号の大きいレイヤーが優先されます。",
  "Toggle Layer":
    "押すたびに指定レイヤーのオン/オフを切り替えます。ロックして常時そのレイヤーで使いたいときに便利。もう一度押すか、デフォルトレイヤーに戻るまで維持されます。",
  "Sticky Key":
    "次の1キー入力にだけ、指定した修飾キーを適用します。例: &sk LSHIFT → 押してから文字キーを押すと、Shift を押し続けなくてもその1文字だけ大文字になります。",
  "Wireless":
    "ワイヤレス接続プロファイルの切り替え・クリアを制御します。BT_SEL 0〜4 でデバイス切り替え、BT_CLR で現在のプロファイル接続解除、BT_CLR_ALL で全プロファイルを一括クリアします。",
  "Wireless Layer":
    "BT0〜BT4 の接続先を選択し、BT0 はレイヤー 0 相当に戻し、BT1〜BT4 は対応するレイヤー 1〜4 を有効化します。接続先ごとにOS差分レイヤーを使い分けたい場合に使います。",
  "Wireless Base":
    "BT0〜BT4 の接続先を選択し、レイヤー 1〜4 をすべて無効化してデフォルトレイヤー相当に戻します。OS差分レイヤーを使わない接続先に使います。",
  "Output Selection":
    "入力の出力先（USB / BLE）を選択します。OUT_USB で USB ホストへの入力を優先、OUT_BLE で Bluetooth を優先。同時接続している場合にどちらへ送るかを制御します。",
  "Transparent":
    "このキーには何も割り当てず、下位レイヤー（より番号の小さいアクティブなレイヤー）の設定をそのまま使います。上位レイヤーで変えたいキーだけ設定し、残りは &trans にするのが基本設計です。",
  "None":
    "このキーを完全に無効化します。下位レイヤーの設定も無視し、何も送信しません。誤操作を防ぎたいキーや、意図的に何もさせたくないキーに使います。",
  "Studio Unlock":
    "ZMK Studio のロックを解除します。Studio 接続時にキーボード側での確認が必要な場合、このキーを押してアンロックします。専用レイヤー（WIRELESS レイヤーなど）に配置するのが一般的です。",
  "Bootloader":
    "キーボードをブートローダーモードに移行します。UF2 ファームウェアの書き込みが必要なときに使います。誤操作防止のため専用レイヤーに配置し、単独では押せないコンボ位置に置くことを推奨します。",
  "External Power":
    "キーボードの外部電源出力（LED・バックライトなど）をオン/オフします。EP_ON / EP_OFF / EP_TOG で制御。LED を使わないときに消費電力を下げるために使います。",
  "Grave/Escape":
    "修飾キーなしで押すと Grave（`）、Shift または GUI（Super）を押しながら押すと Escape を送信します。バッククォートと Escape を1キーで使い分けたい場合に便利なコンビネーションビヘイビアです。",
  "Key Repeat":
    "直前に送信したキーコードをもう一度送信します。同じキーを素早く繰り返したい場合や、連打操作を1キーにまとめたい場合に便利です。",
  "Key Toggle":
    "指定したキーコードの「押しっぱなし状態」と「離した状態」を交互に切り替えます。特定のキーを保持したまま他の操作をしたいときに使います。ゲームでのスティック固定などに活用できます。",
};

export const BehaviorBindingPicker = ({
  binding,
  layers,
  behaviors,
  savedBinding,
  onBindingChanged,
  onRevert,
}: BehaviorBindingPickerProps) => {
  const [behaviorId, setBehaviorId] = useState(binding.behaviorId);
  const [param1, setParam1] = useState<number | undefined>(binding.param1);
  const [param2, setParam2] = useState<number | undefined>(binding.param2);

  const isChanged = savedBinding !== undefined && (
    binding.behaviorId !== savedBinding.behaviorId ||
    binding.param1 !== savedBinding.param1 ||
    binding.param2 !== savedBinding.param2
  );

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
        const ai = BEHAVIOR_PRIORITY.indexOf(behaviorLabel(a.displayName));
        const bi = BEHAVIOR_PRIORITY.indexOf(behaviorLabel(b.displayName));
        if (ai === -1 && bi === -1) return behaviorLabel(a.displayName).localeCompare(behaviorLabel(b.displayName));
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
      if (!behaviors.some((b) => b.id === behaviorId)) {
        console.error(
          "Can't find metadata for the selected behaviorId",
          behaviorId
        );
        return;
      }
      onBindingChanged({ behaviorId, param1: 0, param2: 0 });
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
              {behaviorLabel(b.displayName)}
            </label>
          ))}
        </div>
      </div>

      {/* Right pane: header + parameters */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-2.5 border-b border-base-300 shrink-0 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold text-base">{selectedBehavior ? behaviorLabel(selectedBehavior.displayName) : "—"}</div>
            {selectedBehavior && (
              <div className="text-sm text-base-content/50 mt-0.5">
                {BEHAVIOR_DESCRIPTIONS[behaviorLabel(selectedBehavior.displayName)] ?? ""}
              </div>
            )}
          </div>
          {isChanged && onRevert && (
            <button
              type="button"
              title="元に戻す"
              onClick={onRevert}
              className="shrink-0 mt-0.5 p-1 rounded hover:bg-base-300 text-base-content/50 hover:text-base-content transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
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
