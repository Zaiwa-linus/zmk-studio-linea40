import React, {
  SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePub, useSub } from "../usePubSub";

import { Request } from "@zmkfirmware/zmk-studio-ts-client";
import { call_rpc } from "../rpc/logging";
import {
  PhysicalLayout,
  Keymap,
  SetLayerBindingResponse,
  SetLayerPropsResponse,
  BehaviorBinding,
  Layer,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";

import { SlidersHorizontal } from "lucide-react";
import { LayerPicker } from "./LayerPicker";
import { PhysicalLayoutPicker } from "./PhysicalLayoutPicker";
import { GlobalSettings } from "../GlobalSettings";
import { Keymap as KeymapComp } from "./Keymap";
import { EncoderBindingPicker, EncoderKey } from "./EncoderBindings";
import type { EncoderPreset } from "./EncoderBindings";
import { useConnectedDeviceData } from "../rpc/useConnectedDeviceData";
import { ConnectionContext } from "../rpc/ConnectionContext";
import { CustomRpcContext } from "../rpc/CustomRpcContext";
import { UndoRedoContext } from "../undoRedo";
import { BehaviorBindingPicker } from "../behaviors/BehaviorBindingPicker";
import { produce } from "immer";
import { LockStateContext } from "../rpc/LockStateContext";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { deserializeLayoutZoom, LayoutZoom } from "./PhysicalLayout";
import { useLocalStorageState } from "../misc/useLocalStorageState";
import {
  findCormoranRipIndex,
  getEncoderBindings,
  setEncoderBinding,
  type EncoderLayerBinding,
} from "../rpc/ripRpc";

type BehaviorMap = Record<number, GetBehaviorDetailsResponse>;

// Behaviors that are encoder-only and should NOT appear in the key binding picker.
// Uses substring match on normalized names (lowercase, non-alphanumeric → "_").
// Everything NOT matched here is shown in the key binding picker, including custom behaviors.
const ENCODER_ONLY_NORMALIZED_NAMES: string[] = [
  "sensor_transparent",
  "sensor_trans",
  "mouse_whe",
  "mouse_scrl",
  "mouse_wheel",
  "sensor_ro",
  "re_kp",
  "sensor_rotate",
  "enc_key_p",
  "inc_dec_kp",
];

function isEncoderBehavior(behavior: GetBehaviorDetailsResponse | undefined): boolean {
  if (behavior === undefined) return false;
  const norm = normalizeBehaviorName(behavior.displayName);
  return ENCODER_ONLY_NORMALIZED_NAMES.some((name) => norm.includes(name));
}

function bindingKey(binding: BehaviorBinding): string {
  return `${binding.behaviorId}:${binding.param1 ?? 0}:${binding.param2 ?? 0}`;
}

interface EncoderPresetDefinition {
  behaviorNames: string[];
  param1: number;
  param2: number;
  label: string;
  description: string;
}

// param1 = 時計回り(右回し) / param2 = 反時計回り(左回し)
const LINEA40_ENCODER_PRESET_DEFINITIONS: EncoderPresetDefinition[] = [
  {
    behaviorNames: ["sensor_transparent", "sensor_trans"],
    param1: 0,
    param2: 0,
    label: "透過（下のレイヤーを継承）",
    description: "このレイヤーでは割り当てず、下のレイヤーのエンコーダー動作を使う",
  },
  {
    behaviorNames: ["mouse_whe", "mouse_scrl", "mouse_wheel"],
    param1: 65386,
    param2: 150,
    label: "縦スクロール",
    description: "右回し: 下へ / 左回し: 上へ",
  },
  {
    behaviorNames: ["mouse_whe", "mouse_scrl", "mouse_wheel"],
    param1: 150,
    param2: 65386,
    label: "縦スクロール（反転）",
    description: "右回し: 上へ / 左回し: 下へ",
  },
  {
    behaviorNames: ["sensor_ro", "re_kp", "sensor_rotate"],
    param1: 786665,
    param2: 786666,
    label: "音量",
    description: "右回し: 音量を上げる / 左回し: 下げる",
  },
  {
    behaviorNames: ["sensor_ro", "re_kp", "sensor_rotate"],
    param1: 786666,
    param2: 786665,
    label: "音量（反転）",
    description: "右回し: 音量を下げる / 左回し: 上げる",
  },
  {
    behaviorNames: ["enc_key_p", "inc_dec_kp"],
    param1: 458834,
    param2: 458833,
    label: "上下キー（↑↓）",
    description: "右回し: ↑ / 左回し: ↓",
  },
  {
    behaviorNames: ["enc_key_p", "inc_dec_kp"],
    param1: 458833,
    param2: 458834,
    label: "上下キー（反転）",
    description: "右回し: ↓ / 左回し: ↑",
  },
  {
    behaviorNames: ["enc_key_p", "inc_dec_kp"],
    param1: 458831,
    param2: 458832,
    label: "左右キー（←→）",
    description: "右回し: → / 左回し: ←",
  },
  {
    behaviorNames: ["enc_key_p", "inc_dec_kp"],
    param1: 458832,
    param2: 458831,
    label: "左右キー（反転）",
    description: "右回し: ← / 左回し: →",
  },
];

function normalizeBehaviorName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function findEncoderBehaviorId(
  behaviors: BehaviorMap,
  behaviorNames: string[],
): number | undefined {
  const normalizedNames = behaviorNames.map(normalizeBehaviorName);
  const behavior = Object.values(behaviors).find((b) => {
    if (!isEncoderBehavior(b)) return false;
    const displayName = normalizeBehaviorName(b.displayName);
    return normalizedNames.some((name) => displayName.includes(name));
  });
  return behavior?.id;
}

function useBehaviors(): BehaviorMap {
  let connection = useContext(ConnectionContext);
  let lockState = useContext(LockStateContext);

  const [behaviors, setBehaviors] = useState<BehaviorMap>({});

  useEffect(() => {
    if (
      !connection.conn ||
      lockState != LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
    ) {
      setBehaviors({});
      return;
    }

    async function startRequest() {
      setBehaviors({});

      if (!connection.conn) {
        return;
      }

      let get_behaviors: Request = {
        behaviors: { listAllBehaviors: true },
        requestId: 0,
      };

      let behavior_list = await call_rpc(connection.conn, get_behaviors);
      if (!ignore) {
        let behavior_map: BehaviorMap = {};
        for (let behaviorId of behavior_list.behaviors?.listAllBehaviors
          ?.behaviors || []) {
          if (ignore) {
            break;
          }
          let details_req = {
            behaviors: { getBehaviorDetails: { behaviorId } },
            requestId: 0,
          };
          let behavior_details = await call_rpc(connection.conn, details_req);
          let dets: GetBehaviorDetailsResponse | undefined =
            behavior_details?.behaviors?.getBehaviorDetails;

          if (dets) {
            behavior_map[dets.id] = dets;
          }
        }

        if (!ignore) {
          setBehaviors(behavior_map);
        }
      }
    }

    let ignore = false;
    startRequest();

    return () => {
      ignore = true;
    };
  }, [connection, lockState]);

  return behaviors;
}

function useLayouts(): [
  PhysicalLayout[] | undefined,
  React.Dispatch<SetStateAction<PhysicalLayout[] | undefined>>,
  number,
  React.Dispatch<SetStateAction<number>>
] {
  let connection = useContext(ConnectionContext);
  let lockState = useContext(LockStateContext);

  const [layouts, setLayouts] = useState<PhysicalLayout[] | undefined>(
    undefined
  );
  const [selectedPhysicalLayoutIndex, setSelectedPhysicalLayoutIndex] =
    useState<number>(0);

  useEffect(() => {
    if (
      !connection.conn ||
      lockState != LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
    ) {
      setLayouts(undefined);
      return;
    }

    async function startRequest() {
      setLayouts(undefined);

      if (!connection.conn) {
        return;
      }

      let response = await call_rpc(connection.conn, {
        keymap: { getPhysicalLayouts: true },
      });

      if (!ignore) {
        setLayouts(response?.keymap?.getPhysicalLayouts?.layouts);
        setSelectedPhysicalLayoutIndex(
          response?.keymap?.getPhysicalLayouts?.activeLayoutIndex || 0
        );
      }
    }

    let ignore = false;
    startRequest();

    return () => {
      ignore = true;
    };
  }, [connection, lockState]);

  return [
    layouts,
    setLayouts,
    selectedPhysicalLayoutIndex,
    setSelectedPhysicalLayoutIndex,
  ];
}

export default function Keyboard() {
  const [
    layouts,
    _setLayouts,
    selectedPhysicalLayoutIndex,
    setSelectedPhysicalLayoutIndex,
  ] = useLayouts();
  const [keymap, setKeymap] = useConnectedDeviceData<Keymap>(
    { keymap: { getKeymap: true } },
    (keymap) => {
      console.log("Got the keymap!");
      return keymap?.keymap?.getKeymap;
    },
    true
  );

  const [savedKeymap, setSavedKeymap] = useState<Keymap | undefined>(undefined);

  useEffect(() => {
    if (keymap === undefined) {
      setSavedKeymap(undefined);
    } else {
      setSavedKeymap((prev) => prev === undefined ? keymap : prev);
    }
  }, [keymap]);

  useSub("keymap_saved", () => {
    if (keymap) setSavedKeymap(keymap);
    setSavedEncoderLayerBindings(encoderLayerBindings);
  });

  useSub("keymap_discarded", () => {
    if (!savedEncoderLayerBindings) return;
    setEncoderLayerBindings(savedEncoderLayerBindings);
    const idx = ripSubsystemIndexRef.current;
    if (!customChannel || idx === null) return;
    for (const saved of savedEncoderLayerBindings) {
      setEncoderBinding(customChannel, idx, saved.layerId, saved.binding)
        .catch((e) => console.error("Failed to revert encoder binding", e));
    }
  });

  useSub("keymap_saved", () => {
    if (!encoderLayerBindings) return;
    setSavedEncoderLayerBindings(encoderLayerBindings);
  });

  const [keymapScale, setKeymapScale] = useLocalStorageState<LayoutZoom>("keymapScale", "auto", {
    deserialize: deserializeLayoutZoom,
  });

  const [selectedLayerIndex, setSelectedLayerIndex] = useState<number>(0);
  const [selectedKeyPosition, setSelectedKeyPosition] = useState<
    number | undefined
  >(undefined);
  const [selectedEncoder, setSelectedEncoder] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const behaviors = useBehaviors();

  const conn = useContext(ConnectionContext);
  const undoRedo = useContext(UndoRedoContext);
  const customChannel = useContext(CustomRpcContext);
  const lockState = useContext(LockStateContext);
  const pub = usePub();

  const ripSubsystemIndexRef = useRef<number | null>(null);
  const [encoderLayerBindings, setEncoderLayerBindings] = useState<
    EncoderLayerBinding[] | null
  >(null);
  const [savedEncoderLayerBindings, setSavedEncoderLayerBindings] = useState<
    EncoderLayerBinding[] | null
  >(null);

  useEffect(() => {
    if (
      !customChannel ||
      lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
    ) {
      setEncoderLayerBindings(null);
      setSavedEncoderLayerBindings(null);
      ripSubsystemIndexRef.current = null;
      return;
    }

    let cancelled = false;
    (async () => {
      if (ripSubsystemIndexRef.current === null) {
        ripSubsystemIndexRef.current = await findCormoranRipIndex(customChannel);
      }
      const idx = ripSubsystemIndexRef.current;
      if (idx === null || cancelled) return;
      const bindings = await getEncoderBindings(customChannel, idx);
      if (!cancelled) {
        setEncoderLayerBindings(bindings);
        setSavedEncoderLayerBindings(bindings);
      }
    })();

    return () => { cancelled = true; };
  }, [customChannel, lockState]);

  useEffect(() => {
    setSelectedLayerIndex(0);
    setSelectedKeyPosition(undefined);
    setSelectedEncoder(false);
    setShowGlobalSettings(false);
  }, [conn]);

  const selectLayer = useCallback((i: number) => {
    setShowGlobalSettings(false);
    setSelectedLayerIndex(i);
  }, []);

  useEffect(() => {
    async function performSetRequest() {
      if (!conn.conn || !layouts) {
        return;
      }

      let resp = await call_rpc(conn.conn, {
        keymap: { setActivePhysicalLayout: selectedPhysicalLayoutIndex },
      });

      let new_keymap = resp?.keymap?.setActivePhysicalLayout?.ok;
      if (new_keymap) {
        setKeymap(new_keymap);
      } else {
        console.error(
          "Failed to set the active physical layout err:",
          resp?.keymap?.setActivePhysicalLayout?.err
        );
      }
    }

    performSetRequest();
  }, [selectedPhysicalLayoutIndex]);

  let doSelectPhysicalLayout = useCallback(
    (i: number) => {
      let oldLayout = selectedPhysicalLayoutIndex;
      undoRedo?.(async () => {
        setSelectedPhysicalLayoutIndex(i);

        return async () => {
          setSelectedPhysicalLayoutIndex(oldLayout);
        };
      });
    },
    [undoRedo, selectedPhysicalLayoutIndex]
  );

  let doUpdateBinding = useCallback(
    (binding: BehaviorBinding) => {
      if (!keymap || selectedKeyPosition === undefined) {
        console.error(
          "Can't update binding without a selected key position and loaded keymap"
        );
        return;
      }

      const layer = selectedLayerIndex;
      const layerId = keymap.layers[layer].id;
      const keyPosition = selectedKeyPosition;
      const oldBinding = keymap.layers[layer].bindings[keyPosition];
      undoRedo?.(async () => {
        if (!conn.conn) {
          throw new Error("Not connected");
        }

        let resp = await call_rpc(conn.conn, {
          keymap: { setLayerBinding: { layerId, keyPosition, binding } },
        });

        if (
          resp.keymap?.setLayerBinding ===
          SetLayerBindingResponse.SET_LAYER_BINDING_RESP_OK
        ) {
          setKeymap(
            produce((draft: any) => {
              draft.layers[layer].bindings[keyPosition] = binding;
            })
          );
        } else {
          console.error("Failed to set binding", resp.keymap?.setLayerBinding);
        }

        return async () => {
          if (!conn.conn) {
            return;
          }

          let resp = await call_rpc(conn.conn, {
            keymap: {
              setLayerBinding: { layerId, keyPosition, binding: oldBinding },
            },
          });
          if (
            resp.keymap?.setLayerBinding ===
            SetLayerBindingResponse.SET_LAYER_BINDING_RESP_OK
          ) {
            setKeymap(
              produce((draft: any) => {
                draft.layers[layer].bindings[keyPosition] = oldBinding;
              })
            );
          } else {
          }
        };
      });
    },
    [conn, keymap, undoRedo, selectedLayerIndex, selectedKeyPosition]
  );

  const hasEncoderChanges = useMemo<boolean>(() => {
    if (!encoderLayerBindings || !savedEncoderLayerBindings) return false;
    for (const cur of encoderLayerBindings) {
      const sav = savedEncoderLayerBindings.find((e) => e.layerId === cur.layerId);
      if (!sav) return true;
      if (cur.binding.behaviorId !== sav.binding.behaviorId ||
          cur.binding.param1 !== sav.binding.param1 ||
          cur.binding.param2 !== sav.binding.param2) {
        return true;
      }
    }
    return false;
  }, [encoderLayerBindings, savedEncoderLayerBindings]);

  useEffect(() => {
    pub("encoder_unsaved_changed", hasEncoderChanges);
  }, [hasEncoderChanges]);

  const encoderChangedForLayer = useMemo<boolean>(() => {
    if (!encoderLayerBindings || !savedEncoderLayerBindings || !keymap?.layers[selectedLayerIndex]) return false;
    const layerId = keymap.layers[selectedLayerIndex].id;
    const cur = encoderLayerBindings.find((e) => e.layerId === layerId);
    const sav = savedEncoderLayerBindings.find((e) => e.layerId === layerId);
    if (!cur || !sav) return cur !== sav;
    return (
      cur.binding.behaviorId !== sav.binding.behaviorId ||
      cur.binding.param1 !== sav.binding.param1 ||
      cur.binding.param2 !== sav.binding.param2
    );
  }, [encoderLayerBindings, savedEncoderLayerBindings, keymap, selectedLayerIndex]);

  const encoderBindingForLayer = useMemo<BehaviorBinding | null>(() => {
    if (!encoderLayerBindings || !keymap?.layers[selectedLayerIndex]) return null;
    const layerId = keymap.layers[selectedLayerIndex].id;
    const entry = encoderLayerBindings.find((e) => e.layerId === layerId);
    if (!entry) return null;
    return { behaviorId: entry.binding.behaviorId, param1: entry.binding.param1, param2: entry.binding.param2 };
  }, [encoderLayerBindings, keymap, selectedLayerIndex]);

  const encoderBindingPresets = useMemo<EncoderPreset[]>(() => {
    const presets = new Map<string, EncoderPreset>();
    LINEA40_ENCODER_PRESET_DEFINITIONS.forEach((preset) => {
      const behaviorId = findEncoderBehaviorId(behaviors, preset.behaviorNames);
      if (behaviorId === undefined) return;
      const binding = {
        behaviorId,
        param1: preset.param1,
        param2: preset.param2,
      };
      presets.set(bindingKey(binding), {
        binding,
        label: preset.label,
        description: preset.description,
      });
    });

    // 現在/保存済みの割り当てが定義済みプリセットに無い場合のフォールバック
    const addPreset = (entry: EncoderLayerBinding) => {
      const behavior = behaviors[entry.binding.behaviorId];
      if (!isEncoderBehavior(behavior)) return;
      const binding = {
        behaviorId: entry.binding.behaviorId,
        param1: entry.binding.param1,
        param2: entry.binding.param2,
      };
      const key = bindingKey(binding);
      if (presets.has(key)) return;
      const behaviorName = behavior?.displayName ?? `#${binding.behaviorId}`;
      presets.set(key, {
        binding,
        label: `${behaviorName}（現在の設定）`,
        description: `右回し: ${binding.param1 ?? 0} / 左回し: ${binding.param2 ?? 0}`,
      });
    };

    savedEncoderLayerBindings?.forEach(addPreset);
    encoderLayerBindings?.forEach(addPreset);

    return Array.from(presets.values());
  }, [behaviors, encoderLayerBindings, savedEncoderLayerBindings]);

  const keyAssignableBehaviors = useMemo<GetBehaviorDetailsResponse[]>(
    () => Object.values(behaviors).filter((behavior) => !isEncoderBehavior(behavior)),
    [behaviors]
  );

  const doUpdateEncoderBinding = useCallback(async (binding: BehaviorBinding) => {
    if (!customChannel || !keymap?.layers[selectedLayerIndex]) return;
    const idx = ripSubsystemIndexRef.current;
    if (idx === null) return;
    const layerId = keymap.layers[selectedLayerIndex].id;
    const updated = {
      layerId,
      binding: {
        behaviorId: binding.behaviorId,
        param1: binding.param1 ?? 0,
        param2: binding.param2 ?? 0,
      },
    };

    let previousBindings: EncoderLayerBinding[] | null = null;
    setEncoderLayerBindings((prev) => {
      previousBindings = prev;
      if (!prev) return prev;
      const exists = prev.find((e) => e.layerId === layerId);
      return exists
        ? prev.map((e) => e.layerId === layerId ? updated : e)
        : [...prev, updated];
    });

    const ok = await setEncoderBinding(customChannel, idx, layerId, {
      behaviorId: updated.binding.behaviorId,
      param1: updated.binding.param1,
      param2: updated.binding.param2,
    });
    if (!ok) {
      console.error("Failed to set encoder binding", updated);
      setEncoderLayerBindings(previousBindings);
    }
  }, [customChannel, keymap, selectedLayerIndex]);

  let selectedBinding = useMemo(() => {
    if (selectedEncoder) return null;
    if (keymap == null || selectedKeyPosition == null || !keymap.layers[selectedLayerIndex]) {
      return null;
    }

    return keymap.layers[selectedLayerIndex].bindings[selectedKeyPosition];
  }, [keymap, selectedLayerIndex, selectedKeyPosition, selectedEncoder]);

  const selectedSavedBinding = useMemo(() => {
    if (selectedEncoder || savedKeymap == null || selectedKeyPosition == null || !savedKeymap.layers[selectedLayerIndex]) {
      return undefined;
    }
    const savedLayer = savedKeymap.layers.find(
      (l) => l.id === keymap?.layers[selectedLayerIndex]?.id
    );
    return savedLayer?.bindings[selectedKeyPosition];
  }, [savedKeymap, keymap, selectedLayerIndex, selectedKeyPosition, selectedEncoder]);

  const changedLayers = useMemo(() => {
    if (!keymap || !savedKeymap) return new Set<number>();
    const changed = new Set<number>();
    for (let li = 0; li < keymap.layers.length; li++) {
      const layer = keymap.layers[li];
      const savedLayer = savedKeymap.layers.find((l) => l.id === layer.id);
      if (!savedLayer) { changed.add(li); continue; }
      for (let ki = 0; ki < layer.bindings.length; ki++) {
        const b = layer.bindings[ki];
        const s = savedLayer.bindings[ki];
        if (!s || b.behaviorId !== s.behaviorId || b.param1 !== s.param1 || b.param2 !== s.param2) {
          changed.add(li);
          break;
        }
      }
    }
    return changed;
  }, [keymap, savedKeymap]);

  useEffect(() => {
    pub("keymap_unsaved_changed", changedLayers.size > 0);
  }, [changedLayers]);

  const changedKeys = useMemo(() => {
    if (!keymap || !savedKeymap) return new Set<number>();
    const layer = keymap.layers[selectedLayerIndex];
    if (!layer) return new Set<number>();
    const savedLayer = savedKeymap.layers.find((l) => l.id === layer.id);
    if (!savedLayer) return new Set<number>(layer.bindings.map((_, i) => i));
    const changed = new Set<number>();
    for (let ki = 0; ki < layer.bindings.length; ki++) {
      const b = layer.bindings[ki];
      const s = savedLayer.bindings[ki];
      if (!s || b.behaviorId !== s.behaviorId || b.param1 !== s.param1 || b.param2 !== s.param2) {
        changed.add(ki);
      }
    }
    return changed;
  }, [keymap, savedKeymap, selectedLayerIndex]);

  const moveLayer = useCallback(
    (start: number, end: number) => {
      const doMove = async (startIndex: number, destIndex: number) => {
        if (!conn.conn) {
          return;
        }

        let resp = await call_rpc(conn.conn, {
          keymap: { moveLayer: { startIndex, destIndex } },
        });

        if (resp.keymap?.moveLayer?.ok) {
          setKeymap(resp.keymap?.moveLayer?.ok);
          setSelectedLayerIndex(destIndex);
        } else {
          console.error("Error moving", resp);
        }
      };

      undoRedo?.(async () => {
        await doMove(start, end);
        return () => doMove(end, start);
      });
    },
    [undoRedo]
  );

  const addLayer = useCallback(() => {
    async function doAdd(): Promise<number> {
      if (!conn.conn || !keymap) {
        throw new Error("Not connected");
      }

      const resp = await call_rpc(conn.conn, { keymap: { addLayer: {} } });

      if (resp.keymap?.addLayer?.ok) {
        const newSelection = keymap.layers.length;
        setKeymap(
          produce((draft: any) => {
            draft.layers.push(resp.keymap!.addLayer!.ok!.layer);
            draft.availableLayers--;
          })
        );

        setSelectedLayerIndex(newSelection);

        return resp.keymap.addLayer.ok.index;
      } else {
        console.error("Add error", resp.keymap?.addLayer?.err);
        throw new Error("Failed to add layer:" + resp.keymap?.addLayer?.err);
      }
    }

    async function doRemove(layerIndex: number) {
      if (!conn.conn) {
        throw new Error("Not connected");
      }

      const resp = await call_rpc(conn.conn, {
        keymap: { removeLayer: { layerIndex } },
      });

      console.log(resp);
      if (resp.keymap?.removeLayer?.ok) {
        setKeymap(
          produce((draft: any) => {
            draft.layers.splice(layerIndex, 1);
            draft.availableLayers++;
          })
        );
      } else {
        console.error("Remove error", resp.keymap?.removeLayer?.err);
        throw new Error(
          "Failed to remove layer:" + resp.keymap?.removeLayer?.err
        );
      }
    }

    undoRedo?.(async () => {
      let index = await doAdd();
      return () => doRemove(index);
    });
  }, [conn, undoRedo, keymap]);

  const removeLayer = useCallback(() => {
    async function doRemove(layerIndex: number): Promise<void> {
      if (!conn.conn || !keymap) {
        throw new Error("Not connected");
      }

      const resp = await call_rpc(conn.conn, {
        keymap: { removeLayer: { layerIndex } },
      });

      if (resp.keymap?.removeLayer?.ok) {
        if (layerIndex == keymap.layers.length - 1) {
          setSelectedLayerIndex(layerIndex - 1);
        }
        setKeymap(
          produce((draft: any) => {
            draft.layers.splice(layerIndex, 1);
            draft.availableLayers++;
          })
        );
      } else {
        console.error("Remove error", resp.keymap?.removeLayer?.err);
        throw new Error(
          "Failed to remove layer:" + resp.keymap?.removeLayer?.err
        );
      }
    }

    async function doRestore(layerId: number, atIndex: number) {
      if (!conn.conn) {
        throw new Error("Not connected");
      }

      const resp = await call_rpc(conn.conn, {
        keymap: { restoreLayer: { layerId, atIndex } },
      });

      console.log(resp);
      if (resp.keymap?.restoreLayer?.ok) {
        setKeymap(
          produce((draft: any) => {
            draft.layers.splice(atIndex, 0, resp!.keymap!.restoreLayer!.ok);
            draft.availableLayers--;
          })
        );
        setSelectedLayerIndex(atIndex);
      } else {
        console.error("Remove error", resp.keymap?.restoreLayer?.err);
        throw new Error(
          "Failed to restore layer:" + resp.keymap?.restoreLayer?.err
        );
      }
    }

    if (!keymap) {
      throw new Error("No keymap loaded");
    }

    let index = selectedLayerIndex;
    let layerId = keymap.layers[index].id;
    undoRedo?.(async () => {
      await doRemove(index);
      return () => doRestore(layerId, index);
    });
  }, [conn, undoRedo, selectedLayerIndex]);

  const changeLayerName = useCallback(
    (id: number, oldName: string, newName: string) => {
      async function changeName(layerId: number, name: string) {
        if (!conn.conn) {
          throw new Error("Not connected");
        }

        const resp = await call_rpc(conn.conn, {
          keymap: { setLayerProps: { layerId, name } },
        });

        if (
          resp.keymap?.setLayerProps ==
          SetLayerPropsResponse.SET_LAYER_PROPS_RESP_OK
        ) {
          setKeymap(
            produce((draft: any) => {
              const layer_index = draft.layers.findIndex(
                (l: Layer) => l.id == layerId
              );
              draft.layers[layer_index].name = name;
            })
          );
        } else {
          throw new Error(
            "Failed to change layer name:" + resp.keymap?.setLayerProps
          );
        }
      }

      undoRedo?.(async () => {
        await changeName(id, newName);
        return async () => {
          await changeName(id, oldName);
        };
      });
    },
    [conn, undoRedo, keymap]
  );

  useEffect(() => {
    if (!keymap?.layers) return;

    const layers = keymap.layers.length - 1;

    if (selectedLayerIndex > layers) {
      setSelectedLayerIndex(layers);
    }
  }, [keymap, selectedLayerIndex]);

  const showPicker = (selectedBinding != null) || (selectedEncoder && encoderBindingPresets.length > 0);

  return (
    <div
      className="grid grid-cols-[auto_1fr] bg-base-300 max-w-full min-w-0 min-h-0 h-full"
      style={{
        gridTemplateRows: showGlobalSettings
          ? "1fr 0"
          : showPicker
          ? "3fr 2fr"
          : "1fr 0",
      }}
    >
      <div className="p-2 flex flex-col gap-2 bg-base-200 row-span-2 overflow-y-auto">
        {layouts && (
          <div className="col-start-3 row-start-1 row-end-2">
            <PhysicalLayoutPicker
              layouts={layouts}
              selectedPhysicalLayoutIndex={selectedPhysicalLayoutIndex}
              onPhysicalLayoutClicked={doSelectPhysicalLayout}
            />
          </div>
        )}

        {keymap && (
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded p-1 text-sm transition-colors ${
              showGlobalSettings
                ? "bg-primary text-primary-content"
                : "hover:bg-base-300"
            }`}
            onClick={() => {
              setShowGlobalSettings(true);
              setSelectedKeyPosition(undefined);
              setSelectedEncoder(false);
            }}
          >
            <SlidersHorizontal className="size-4" />
            Global Settings
          </button>
        )}

        {keymap && (
          <div className="col-start-1 row-start-1 row-end-2">
            <LayerPicker
              layers={keymap.layers}
              selectedLayerIndex={selectedLayerIndex}
              changedLayerIndices={changedLayers}
              onLayerClicked={selectLayer}
              onLayerMoved={moveLayer}
              canAdd={(keymap.availableLayers || 0) > 0}
              canRemove={(keymap.layers?.length || 0) > 1}
              onAddClicked={addLayer}
              onRemoveClicked={removeLayer}
              onLayerNameChanged={changeLayerName}
            />
          </div>
        )}
      </div>
      {showGlobalSettings ? (
        <div className="col-start-2 row-start-1 row-span-2 overflow-hidden">
          <GlobalSettings />
        </div>
      ) : (
      <>
      {layouts && keymap && behaviors && (
        <div className="p-2 col-start-2 row-start-1 flex flex-col gap-2 items-center justify-center relative min-w-0">
          <KeymapComp
            keymap={keymap}
            layout={layouts[selectedPhysicalLayoutIndex]}
            behaviors={behaviors}
            scale={keymapScale}
            selectedLayerIndex={selectedLayerIndex}
            selectedKeyPosition={selectedKeyPosition}
            changedKeyPositions={changedKeys}
            onKeyPositionClicked={(pos) => {
              setSelectedKeyPosition(pos);
              setSelectedEncoder(false);
            }}
          />
          {encoderLayerBindings !== null && (
            <div className="absolute left-1/2 top-[42%] z-20 -translate-x-1/2 -translate-y-1/2">
              <EncoderKey
                binding={encoderBindingForLayer}
                behaviors={behaviors}
                selected={selectedEncoder}
                changed={encoderChangedForLayer}
                onClick={() => {
                  setSelectedEncoder(true);
                  setSelectedKeyPosition(undefined);
                }}
              />
            </div>
          )}
          <select
            className="absolute top-2 right-2 h-8 rounded px-2"
            value={keymapScale}
            onChange={(e) => {
              const value = deserializeLayoutZoom(e.target.value);
              setKeymapScale(value);
            }}
          >
            <option value="auto">Auto</option>
            <option value={0.25}>25%</option>
            <option value={0.5}>50%</option>
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
            <option value={1.25}>125%</option>
            <option value={1.5}>150%</option>
            <option value={2}>200%</option>
          </select>
        </div>
      )}
      {showPicker && keymap && (
        <div className="col-start-2 row-start-2 bg-base-200 overflow-hidden">
          {selectedEncoder ? (
            <EncoderBindingPicker
              binding={encoderBindingForLayer}
              presets={encoderBindingPresets}
              onBindingChanged={doUpdateEncoderBinding}
            />
          ) : selectedBinding ? (
            <BehaviorBindingPicker
              binding={selectedBinding}
              behaviors={keyAssignableBehaviors}
              layers={keymap.layers.map(({ id, name }, li) => ({
                id,
                name: name || li.toLocaleString(),
              }))}
              savedBinding={selectedSavedBinding}
              onBindingChanged={doUpdateBinding}
              onRevert={() => selectedSavedBinding && doUpdateBinding(selectedSavedBinding)}
            />
          ) : null}
        </div>
      )}
      </>
      )}
    </div>
  );
}
