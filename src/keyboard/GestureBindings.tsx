import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type { BehaviorBinding } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { CustomRpcContext } from "../rpc/CustomRpcContext";
import { LockStateContext } from "../rpc/LockStateContext";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import {
  GESTURE_DIR_DOWN,
  GESTURE_DIR_LEFT,
  GESTURE_DIR_RIGHT,
  GESTURE_DIR_UP,
  GESTURE_DIR_NAMES,
  gestureBindingIdx,
  getGestureBindings,
  setGestureBinding,
  type GestureBinding,
  type GestureDir,
} from "../rpc/ripRpc";
import { findCormoranRipIndex } from "../rpc/ripRpc";
import { BehaviorBindingPicker } from "../behaviors/BehaviorBindingPicker";

const DIRS: GestureDir[] = [
  GESTURE_DIR_UP,
  GESTURE_DIR_DOWN,
  GESTURE_DIR_LEFT,
  GESTURE_DIR_RIGHT,
];
const DIR_ARROW = ["↑", "↓", "←", "→"] as const;

function emptyBinding(): GestureBinding {
  return { behaviorId: -1, param1: 0, param2: 0 };
}

function bindingsEqual(a: GestureBinding, b: GestureBinding) {
  return a.behaviorId === b.behaviorId && a.param1 === b.param1 && a.param2 === b.param2;
}

interface GestureCellProps {
  binding: GestureBinding;
  behaviors: Record<number, GetBehaviorDetailsResponse>;
  selected: boolean;
  changed: boolean;
  onClick: () => void;
}

function GestureCell({ binding, behaviors, selected, changed, onClick }: GestureCellProps) {
  const label = useMemo(() => {
    if (binding.behaviorId < 0) return "—";
    const b = behaviors[binding.behaviorId];
    if (!b) return `#${binding.behaviorId}`;
    const name = b.displayName ?? "";
    return name.length > 12 ? name.slice(0, 12) : name;
  }, [binding, behaviors]);

  return (
    <button
      className={`relative flex items-center justify-center rounded border text-sm font-medium transition-all cursor-pointer
        ${selected
          ? "bg-primary text-primary-content border-primary shadow-md"
          : "bg-base-100 text-base-content border-base-300 hover:border-primary hover:bg-base-200"}
        `}
      style={{ width: 144, height: 80 }}
      onClick={onClick}
      title={binding.behaviorId >= 0 ? `${binding.behaviorId} p1=${binding.param1} p2=${binding.param2}` : "未設定"}
    >
      {changed && (
        <span className="absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-purple-500 pointer-events-none" />
      )}
      <span className="truncate px-1">{label}</span>
    </button>
  );
}

interface GestureBindingsProps {
  behaviors: Record<number, GetBehaviorDetailsResponse>;
  /** Called whenever any binding changes, so the parent can track unsaved state */
  onUnsavedChange?: (hasUnsaved: boolean) => void;
}

export function GestureBindings({ behaviors, onUnsavedChange }: GestureBindingsProps) {
  const customChannel = useContext(CustomRpcContext);
  const lockState = useContext(LockStateContext);

  const subsystemIndexRef = useRef<number | null>(null);
  const [bindings, setBindings] = useState<GestureBinding[] | null>(null);
  const [savedBindings, setSavedBindings] = useState<GestureBinding[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  // Currently selected cell: {d1, d2} or null
  const [selected, setSelected] = useState<{ d1: GestureDir; d2: GestureDir } | null>(null);

  /* Load bindings on connect/unlock */
  useEffect(() => {
    if (!customChannel || lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED) {
      setLoading(true);
      setAvailable(true);
      setBindings(null);
      setSavedBindings(null);
      setSelected(null);
      subsystemIndexRef.current = null;
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
        const loaded = await getGestureBindings(customChannel, idx);
        if (!cancelled) {
          if (loaded) {
            // Pad to 12 if fewer returned
            const padded = [...loaded];
            while (padded.length < 12) padded.push(emptyBinding());
            setBindings(padded);
            setSavedBindings(padded);
          } else {
            setAvailable(false);
          }
        }
      } catch (e) {
        console.error("Failed to load gesture bindings", e);
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [customChannel, lockState]);

  const hasUnsaved = useMemo(() => {
    if (!bindings || !savedBindings) return false;
    return bindings.some((b, i) => !bindingsEqual(b, savedBindings[i]));
  }, [bindings, savedBindings]);

  useEffect(() => {
    onUnsavedChange?.(hasUnsaved);
  }, [hasUnsaved, onUnsavedChange]);

  const selectedBinding = useMemo<BehaviorBinding | null>(() => {
    if (!selected || !bindings) return null;
    const idx = gestureBindingIdx(selected.d1, selected.d2);
    if (idx < 0) return null;
    const g = bindings[idx];
    if (g.behaviorId < 0) return null;
    return { behaviorId: g.behaviorId, param1: g.param1, param2: g.param2 };
  }, [selected, bindings]);

  const handleBindingChange = useCallback(async (bb: BehaviorBinding) => {
    if (!selected || !customChannel) return;
    const idx = subsystemIndexRef.current;
    if (idx === null) return;

    const newGBinding: GestureBinding = {
      behaviorId: bb.behaviorId,
      param1: bb.param1 ?? 0,
      param2: bb.param2 ?? 0,
    };

    setBindings((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const gi = gestureBindingIdx(selected.d1, selected.d2);
      if (gi >= 0) next[gi] = newGBinding;
      return next;
    });

    const ok = await setGestureBinding(customChannel, idx, selected.d1, selected.d2, newGBinding);
    if (!ok) {
      // Revert on failure
      setBindings((prev) => {
        if (!prev || !savedBindings) return prev;
        const next = [...prev];
        const gi = gestureBindingIdx(selected.d1, selected.d2);
        if (gi >= 0) next[gi] = savedBindings[gi];
        return next;
      });
    }
  }, [selected, customChannel, savedBindings]);

  const keyAssignableBehaviors = useMemo(
    () => Object.values(behaviors).filter((b) => b != null),
    [behaviors],
  );

  /** Fallback binding when no gesture is assigned: use &none (or first behavior) */
  const fallbackBinding = useMemo<BehaviorBinding>(() => {
    const none = keyAssignableBehaviors.find((b) =>
      (b.displayName ?? "").toLowerCase().includes("none"),
    );
    const first = keyAssignableBehaviors[0];
    const b = none ?? first;
    return b ? { behaviorId: b.id, param1: 0, param2: 0 } : { behaviorId: 0, param1: 0, param2: 0 };
  }, [keyAssignableBehaviors]);

  const isUnavailable = !loading && !available;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-base-300 shrink-0 bg-base-200">
        <div className="font-semibold text-base">マウスジェスチャー</div>
        <div className="text-xs text-base-content/50 mt-0.5">
          ジェスチャーキーを押しながらトラックボールを2方向に振ると発動します。
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-base-content/60">
          読み込み中…
        </div>
      ) : isUnavailable ? (
        <div className="flex-1 flex items-center justify-center text-sm text-base-content/60 px-4 text-center">
          ジェスチャー機能に対応したファームウェアが見つかりませんでした。
        </div>
      ) : bindings ? (
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* 4×4 grid (same-direction cells disabled) */}
          <div className="shrink-0 p-4">
            <table className="border-separate" style={{ borderSpacing: 4 }}>
              <thead>
                <tr>
                  <th className="w-10" />
                  {DIRS.map((d2) => (
                    <th key={d2} className="text-center text-sm text-base-content/60 pb-2">
                      {DIR_ARROW[d2]}&nbsp;{GESTURE_DIR_NAMES[d2]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DIRS.map((d1) => (
                  <tr key={d1}>
                    <td className="text-right text-sm text-base-content/60 pr-2 whitespace-nowrap">
                      {DIR_ARROW[d1]}&nbsp;{GESTURE_DIR_NAMES[d1]}
                    </td>
                    {DIRS.map((d2) => {
                      if (d1 === d2) {
                        return (
                          <td key={d2}>
                            <div
                              className="flex items-center justify-center rounded bg-base-300 text-base-content/20 text-lg"
                              style={{ width: 144, height: 80 }}
                            >
                              ✕
                            </div>
                          </td>
                        );
                      }
                      const gi = gestureBindingIdx(d1 as GestureDir, d2 as GestureDir);
                      const b = gi >= 0 ? bindings[gi] : emptyBinding();
                      const isSelected = selected?.d1 === d1 && selected?.d2 === d2;
                      const isChanged =
                        savedBindings && gi >= 0
                          ? !bindingsEqual(b, savedBindings[gi])
                          : false;
                      return (
                        <td key={d2}>
                          <GestureCell
                            binding={b}
                            behaviors={behaviors}
                            selected={isSelected}
                            changed={isChanged}
                            onClick={() =>
                              setSelected(
                                isSelected ? null : { d1: d1 as GestureDir, d2: d2 as GestureDir },
                              )
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Binding picker */}
          {selected && (
            <div className="flex-1 overflow-hidden border-t border-base-300">
              <BehaviorBindingPicker
                binding={selectedBinding ?? fallbackBinding}
                behaviors={keyAssignableBehaviors}
                layers={[]}
                savedBinding={selectedBinding ?? undefined}
                onBindingChanged={handleBindingChange}
                onRevert={() => {
                  if (!savedBindings || !selected) return;
                  const gi = gestureBindingIdx(selected.d1, selected.d2);
                  if (gi < 0) return;
                  const saved = savedBindings[gi];
                  if (saved.behaviorId >= 0) {
                    handleBindingChange({
                      behaviorId: saved.behaviorId,
                      param1: saved.param1,
                      param2: saved.param2,
                    });
                  }
                }}
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
