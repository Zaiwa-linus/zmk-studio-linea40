import { useContext, useEffect, useMemo, useRef, useState } from "react";
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
  setCurrentCpi as rpcSetCurrentCpi,
  setTempLayerDeactivationDelay,
  setTempLayerLayer,
  type InputProcessorInfo,
} from "./rpc/ripRpc";
import { usePub, useSub } from "./usePubSub";

const DPI_MIN = 200;
const DPI_MAX = 4000;
const DPI_STEP = 200;

function normalizeDpi(cpi: number): number {
  const clamped = Math.max(DPI_MIN, Math.min(DPI_MAX, cpi));
  return Math.max(
    DPI_MIN,
    Math.min(DPI_MAX, Math.round(clamped / DPI_STEP) * DPI_STEP)
  );
}

export function GlobalSettings() {
  const customChannel = useContext(CustomRpcContext);
  const lockState = useContext(LockStateContext);
  const pub = usePub();

  const subsystemIndexRef = useRef<number | null>(null);
  const processorIdRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  // live FW values (updated after successful RPC)
  const [currentCpi, setCurrentCpi] = useState<number | null>(null);
  const [processor, setProcessor] = useState<InputProcessorInfo | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<number | null>(null);

  // text input state
  const [dpiInput, setDpiInput] = useState<string>("");
  const [timeoutMs, setTimeoutMs] = useState<string>("");

  // Flash snapshot: values at connect or last Save — used for Discard.
  // DPI is excluded because it is applied and persisted immediately.
  const [savedLayerId, setSavedLayerId] = useState<number | null>(null);
  const [savedTimeoutMs, setSavedTimeoutMs] = useState<number | null>(null);

  const [keymap] = useConnectedDeviceData<Keymap>(
    { keymap: { getKeymap: true } },
    (r) => r?.keymap?.getKeymap,
    true
  );

  useEffect(() => {
    if (
      !customChannel ||
      lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
    ) {
      setLoading(true);
      setAvailable(true);
      setCurrentCpi(null);
      setDpiInput("");
      setProcessor(null);
      setSelectedLayerId(null);
      setTimeoutMs("");
      setSavedLayerId(null);
      setSavedTimeoutMs(null);
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
        const resolvedCpi = cpi && cpi > 0 ? cpi : null;

        if (processorIdRef.current === null) {
          processorIdRef.current = await findMouseProcessorId(customChannel, idx);
        }
        const pid = processorIdRef.current;
        if (pid === null) {
          if (!cancelled) setAvailable(false);
          return;
        }

        const info = await getInputProcessor(customChannel, idx, pid);
        if (!cancelled) {
          setCurrentCpi(resolvedCpi);
          setDpiInput(resolvedCpi !== null ? String(resolvedCpi) : "");
          if (info) {
            setProcessor(info);
            setSelectedLayerId(info.tempLayerLayer);
            setTimeoutMs(String(info.tempLayerDeactivationDelayMs));
            // Flash snapshot on connect
            setSavedLayerId(info.tempLayerLayer);
            setSavedTimeoutMs(info.tempLayerDeactivationDelayMs);
          }
        }
      } catch (e) {
        console.error("Failed to load global settings", e);
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [customChannel, lockState]);

  // Unsaved = AML live values differ from Flash snapshot (DPI excluded)
  const isUnsaved = useMemo(() => {
    if (selectedLayerId !== null && savedLayerId !== null && selectedLayerId !== savedLayerId) return true;
    if (processor !== null && savedTimeoutMs !== null && processor.tempLayerDeactivationDelayMs !== savedTimeoutMs) return true;
    return false;
  }, [selectedLayerId, savedLayerId, processor, savedTimeoutMs]);

  useEffect(() => {
    pub("global_settings_unsaved_changed", isUnsaved);
  }, [isUnsaved]);

  // Save: update Flash snapshot to current live values
  useSub("keymap_saved", () => {
    setSavedLayerId(selectedLayerId);
    if (processor !== null) setSavedTimeoutMs(processor.tempLayerDeactivationDelayMs);
  });

  // Discard: revert AML to Flash snapshot (DPI excluded)
  useSub("keymap_discarded", () => {
    const idx = subsystemIndexRef.current;
    const pid = processorIdRef.current;
    if (!customChannel || idx === null || pid === null) return;

    if (savedLayerId !== null && selectedLayerId !== savedLayerId) {
      setTempLayerLayer(customChannel, idx, pid, savedLayerId)
        .then((ok) => {
          if (ok) {
            setSelectedLayerId(savedLayerId);
            setProcessor((p) => (p ? { ...p, tempLayerLayer: savedLayerId } : p));
          }
        })
        .catch((e) => console.error("Failed to revert AML layer", e));
    }

    if (
      savedTimeoutMs !== null &&
      processor !== null &&
      processor.tempLayerDeactivationDelayMs !== savedTimeoutMs
    ) {
      setTempLayerDeactivationDelay(customChannel, idx, pid, savedTimeoutMs)
        .then((ok) => {
          if (ok) {
            setTimeoutMs(String(savedTimeoutMs));
            setProcessor((p) =>
              p ? { ...p, tempLayerDeactivationDelayMs: savedTimeoutMs } : p
            );
          }
        })
        .catch((e) => console.error("Failed to revert AML timeout", e));
    }
  });

  // DPI +/- : UI preview only. Apply sends the persistent RPC.
  const onDpiStep = (delta: number) => {
    const base = parseInt(dpiInput, 10);
    if (!Number.isFinite(base)) return;
    const newCpi = normalizeDpi(base + delta);
    setDpiInput(String(newCpi));
  };

  const onApplyDpi = async () => {
    const idx = subsystemIndexRef.current;
    if (!customChannel || idx === null) return;
    const parsed = parseInt(dpiInput, 10);
    if (!Number.isFinite(parsed) || parsed < DPI_MIN || parsed > DPI_MAX) return;
    const cpi = normalizeDpi(parsed);
    const ok = await rpcSetCurrentCpi(customChannel, idx, cpi);
    if (ok) {
      setCurrentCpi(cpi);
      setDpiInput(String(cpi));
    }
  };

  const onSelectLayer = async (layerId: number) => {
    const idx = subsystemIndexRef.current;
    const pid = processorIdRef.current;
    if (!customChannel || idx === null || pid === null) return;
    const previous = selectedLayerId;
    setSelectedLayerId(layerId);
    const ok = await setTempLayerLayer(customChannel, idx, pid, layerId);
    if (!ok) {
      setSelectedLayerId(previous);
    } else {
      setProcessor((p) => (p ? { ...p, tempLayerLayer: layerId } : p));
    }
  };

  const onApplyTimeout = async () => {
    const idx = subsystemIndexRef.current;
    const pid = processorIdRef.current;
    if (!customChannel || idx === null || pid === null) return;
    const ms = parseInt(timeoutMs, 10);
    if (!Number.isFinite(ms) || ms < 0) return;
    const ok = await setTempLayerDeactivationDelay(customChannel, idx, pid, ms);
    if (ok) setProcessor((p) => (p ? { ...p, tempLayerDeactivationDelayMs: ms } : p));
  };

  const parsedDpiInput = parseInt(dpiInput, 10);
  const dpiApplicable =
    Number.isFinite(parsedDpiInput) &&
    parsedDpiInput >= DPI_MIN &&
    parsedDpiInput <= DPI_MAX &&
    normalizeDpi(parsedDpiInput) !== currentCpi;

  const parsedTimeout = parseInt(timeoutMs, 10);
  const timeoutApplicable =
    Number.isFinite(parsedTimeout) &&
    parsedTimeout >= 0 &&
    parsedTimeout !== processor?.tempLayerDeactivationDelayMs;

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
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">タイムアウト (ms)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={50}
                    className="h-9 w-32 rounded bg-base-100 px-2 tabular-nums"
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(e.target.value)}
                  />
                  <button
                    className="h-9 rounded bg-primary px-3 text-primary-content disabled:opacity-50"
                    disabled={!timeoutApplicable}
                    onClick={onApplyTimeout}
                  >
                    適用
                  </button>
                </div>
                <p className="text-xs text-base-content/50">
                  操作停止からこの時間が経過するとレイヤが解除されます。
                </p>
              </div>
            </section>

            {/* DPI — immediate persistent apply, no Save/Discard */}
            <section className="rounded-lg bg-base-200 p-4">
              <h2 className="mb-1 text-lg">DPI</h2>
              <p className="mb-3 text-sm text-base-content/60">
                トラックボールセンサー (PMW3610) のCPI値を変更します。{DPI_MIN}〜{DPI_MAX}、{DPI_STEP}刻み。
              </p>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <button
                    className="h-9 w-9 rounded bg-base-100 text-lg disabled:opacity-40"
                    disabled={dpiInput === "" || parseInt(dpiInput, 10) <= DPI_MIN}
                    onClick={() => onDpiStep(-DPI_STEP)}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={DPI_MIN}
                    max={DPI_MAX}
                    step={DPI_STEP}
                    className="h-9 w-28 rounded bg-base-100 px-2 tabular-nums"
                    value={dpiInput}
                    onChange={(e) => setDpiInput(e.target.value)}
                  />
                  <button
                    className="h-9 w-9 rounded bg-base-100 text-lg disabled:opacity-40"
                    disabled={dpiInput === "" || parseInt(dpiInput, 10) >= DPI_MAX}
                    onClick={() => onDpiStep(DPI_STEP)}
                  >
                    ＋
                  </button>
                  <button
                    className="h-9 rounded bg-primary px-3 text-primary-content disabled:opacity-50"
                    disabled={!dpiApplicable}
                    onClick={onApplyDpi}
                  >
                    適用
                  </button>
                </div>
                <p className="text-xs text-base-content/50">
                  現在: {currentCpi !== null ? `${currentCpi} DPI` : "—"}
                </p>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
