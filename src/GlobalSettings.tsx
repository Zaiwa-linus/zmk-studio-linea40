import { useContext, useEffect, useRef, useState } from "react";
import { CustomRpcContext } from "./rpc/CustomRpcContext";
import { LockStateContext } from "./rpc/LockStateContext";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { useConnectedDeviceData } from "./rpc/useConnectedDeviceData";
import type { Keymap } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import {
  findCormoranRipIndex,
  findMouseProcessorId,
  getCurrentCpi,
  getInputProcessor,
  setTempLayerDeactivationDelay,
  setTempLayerLayer,
  type InputProcessorInfo,
} from "./rpc/ripRpc";

type SaveState = "idle" | "saving" | "saved" | "error";

function SaveBadge({ state }: { state: SaveState }) {
  if (state === "saving")
    return <span className="text-xs text-base-content/60">保存中…</span>;
  if (state === "saved")
    return <span className="text-xs text-success">保存しました</span>;
  if (state === "error")
    return <span className="text-xs text-error">失敗しました</span>;
  return null;
}

export function GlobalSettings() {
  const customChannel = useContext(CustomRpcContext);
  const lockState = useContext(LockStateContext);

  const subsystemIndexRef = useRef<number | null>(null);
  const processorIdRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [currentCpi, setCurrentCpi] = useState<number | null>(null);
  const [processor, setProcessor] = useState<InputProcessorInfo | null>(null);

  const [selectedLayerId, setSelectedLayerId] = useState<number | null>(null);
  const [timeoutMs, setTimeoutMs] = useState<string>("");

  const [layerSave, setLayerSave] = useState<SaveState>("idle");
  const [timeoutSave, setTimeoutSave] = useState<SaveState>("idle");

  // Layer list (id + name) from the standard keymap RPC.
  const [keymap] = useConnectedDeviceData<Keymap>(
    { keymap: { getKeymap: true } },
    (r) => r?.keymap?.getKeymap,
    true
  );

  // Fetch auto-mouse processor settings + current CPI once on connect/unlock.
  useEffect(() => {
    if (
      !customChannel ||
      lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
    ) {
      setLoading(true);
      setAvailable(true);
      setCurrentCpi(null);
      setProcessor(null);
      setSelectedLayerId(null);
      setTimeoutMs("");
      subsystemIndexRef.current = null;
      processorIdRef.current = null;
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        if (subsystemIndexRef.current === null) {
          subsystemIndexRef.current = await findCormoranRipIndex(customChannel);
        }
        const idx = subsystemIndexRef.current;
        if (idx === null) {
          if (!cancelled) setAvailable(false);
          return;
        }

        const cpi = await getCurrentCpi(customChannel, idx);
        if (!cancelled) setCurrentCpi(cpi && cpi > 0 ? cpi : null);

        if (processorIdRef.current === null) {
          processorIdRef.current = await findMouseProcessorId(customChannel, idx);
        }
        const pid = processorIdRef.current;
        if (pid === null) {
          if (!cancelled) setAvailable(false);
          return;
        }

        const info = await getInputProcessor(customChannel, idx, pid);
        if (!cancelled && info) {
          setProcessor(info);
          setSelectedLayerId(info.tempLayerLayer);
          setTimeoutMs(String(info.tempLayerDeactivationDelayMs));
        }
      } catch (e) {
        console.error("Failed to load global settings", e);
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [customChannel, lockState]);

  const onSelectLayer = async (layerId: number) => {
    const idx = subsystemIndexRef.current;
    const pid = processorIdRef.current;
    if (!customChannel || idx === null || pid === null) return;
    const previous = selectedLayerId;
    setSelectedLayerId(layerId);
    setLayerSave("saving");
    const ok = await setTempLayerLayer(customChannel, idx, pid, layerId);
    if (ok) {
      setLayerSave("saved");
      setProcessor((p) => (p ? { ...p, tempLayerLayer: layerId } : p));
    } else {
      setLayerSave("error");
      setSelectedLayerId(previous);
    }
  };

  const onApplyTimeout = async () => {
    const idx = subsystemIndexRef.current;
    const pid = processorIdRef.current;
    if (!customChannel || idx === null || pid === null) return;
    const ms = parseInt(timeoutMs, 10);
    if (!Number.isFinite(ms) || ms < 0) {
      setTimeoutSave("error");
      return;
    }
    setTimeoutSave("saving");
    const ok = await setTempLayerDeactivationDelay(customChannel, idx, pid, ms);
    if (ok) {
      setTimeoutSave("saved");
      setProcessor((p) => (p ? { ...p, tempLayerDeactivationDelayMs: ms } : p));
    } else {
      setTimeoutSave("error");
    }
  };

  const timeoutDirty =
    processor != null &&
    timeoutMs.trim() !== String(processor.tempLayerDeactivationDelayMs);

  return (
    <div className="bg-base-300 h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <h1 className="text-xl font-semibold">Global Settings</h1>

        {lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED ? (
          <p className="text-base-content/70">
            キーボードのロックを解除すると設定を表示できます。
          </p>
        ) : loading ? (
          <p className="text-base-content/70">読み込み中…</p>
        ) : !available ? (
          <p className="text-base-content/70">
            この機能に対応したファームウェア (cormoran_rip) が見つかりませんでした。
          </p>
        ) : (
          <>
            {/* Auto Mouse Layer */}
            <section className="rounded-lg bg-base-200 p-4">
              <h2 className="mb-1 text-lg">オートマウスレイヤ (AML)</h2>
              <p className="mb-3 text-sm text-base-content/60">
                トラックボール操作中に一時的に有効化されるレイヤと、操作停止後に解除されるまでの時間を設定します。
              </p>

              <div className="mb-4 flex flex-col gap-1">
                <label className="text-sm font-medium">対象レイヤ</label>
                <select
                  className="h-9 w-full max-w-xs rounded bg-base-100 px-2"
                  value={selectedLayerId ?? ""}
                  onChange={(e) => onSelectLayer(Number(e.target.value))}
                >
                  {keymap?.layers.map((layer, i) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name && layer.name.length > 0
                        ? `${i}: ${layer.name}`
                        : `Layer ${i}`}
                    </option>
                  ))}
                </select>
                <SaveBadge state={layerSave} />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">
                  タイムアウト (ms)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={50}
                    className="h-9 w-32 rounded bg-base-100 px-2 tabular-nums"
                    value={timeoutMs}
                    onChange={(e) => {
                      setTimeoutMs(e.target.value);
                      setTimeoutSave("idle");
                    }}
                  />
                  <button
                    className="h-9 rounded bg-primary px-3 text-primary-content disabled:opacity-50"
                    disabled={!timeoutDirty || timeoutSave === "saving"}
                    onClick={onApplyTimeout}
                  >
                    適用
                  </button>
                  <SaveBadge state={timeoutSave} />
                </div>
                <p className="text-xs text-base-content/50">
                  操作停止からこの時間が経過するとレイヤが解除されます。
                </p>
              </div>
            </section>

            {/* Current DPI (read-only) */}
            <section className="rounded-lg bg-base-200 p-4">
              <h2 className="mb-1 text-lg">現在のDPI</h2>
              <p className="mb-3 text-sm text-base-content/60">
                トラックボールセンサー (PMW3610) の現在のCPI値です。確認のみ。
              </p>
              <p className="text-2xl font-semibold tabular-nums">
                {currentCpi !== null ? `${currentCpi} DPI` : "—"}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
