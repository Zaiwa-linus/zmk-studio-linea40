import type { ReactNode } from "react";
import {
  PhysicalLayout,
  Keymap as KeymapMsg,
  BehaviorBinding,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type {
  BehaviorParameterValueDescription,
  GetBehaviorDetailsResponse,
} from "@zmkfirmware/zmk-studio-ts-client/behaviors";

import {
  LayoutZoom,
  PhysicalLayout as PhysicalLayoutComp,
} from "./PhysicalLayout";
import { HidUsageLabel } from "./HidUsageLabel";
import { hid_usage_page_and_id_from_usage } from "../hid-usages";

type BehaviorMap = Record<number, GetBehaviorDetailsResponse>;

const BEHAVIOR_NAME_OVERRIDES: Record<string, string> = {
  Bluetooth: "Wireless",
  bt_layer: "Wireless Layer",
  bt_base: "Wireless Base",
};

const behaviorLabel = (behavior: GetBehaviorDetailsResponse | undefined): string =>
  behavior
    ? BEHAVIOR_NAME_OVERRIDES[behavior.displayName] ?? behavior.displayName
    : "Unknown";

function isBehavior(behavior: GetBehaviorDetailsResponse | undefined, names: string[]): boolean {
  return behavior !== undefined && names.includes(behavior.displayName);
}

function layerName(layers: { id: number; name: string }[], layerId: number): string {
  return layers.find((l) => l.id === layerId)?.name ?? `Layer ${layerId}`;
}

function constantName(
  behavior: GetBehaviorDetailsResponse | undefined,
  param1: number,
): string | undefined {
  return behavior?.metadata
    ?.flatMap((m) => m.param1 ?? [])
    .find((v) => v.constant === param1)
    ?.name;
}

function valueMatchesDescription(
  value: number,
  description: BehaviorParameterValueDescription,
  layers: { id: number; name: string }[],
): boolean {
  if (description.constant !== undefined) return description.constant === value;
  if (description.layerId) return layers.some((layer) => layer.id === value);
  if (description.range) return value >= description.range.min && value <= description.range.max;
  if (description.hidUsage) {
    const [page, id] = hid_usage_page_and_id_from_usage(value & 0x00ffffff);
    return page !== 0 && id !== 0;
  }
  if (description.nil) return value === 0;
  return false;
}

function findValueDescription(
  value: number,
  descriptions: BehaviorParameterValueDescription[] | undefined,
  layers: { id: number; name: string }[],
): BehaviorParameterValueDescription | undefined {
  return descriptions?.find((description) =>
    valueMatchesDescription(value, description, layers)
  );
}

function parameterLabel(
  value: number | undefined,
  descriptions: BehaviorParameterValueDescription[] | undefined,
  layers: { id: number; name: string }[],
): ReactNode | undefined {
  if (value === undefined) return undefined;

  const description = findValueDescription(value, descriptions, layers);
  if (description?.nil) return undefined;
  if (description?.constant !== undefined) return description.name;
  if (description?.layerId) return layerName(layers, value);
  if (description?.hidUsage) return <HidUsageLabel hid_usage={value} />;
  if (description?.range) return `${value}`;

  if (descriptions && descriptions.length > 0) return `${value}`;
  return value !== 0 ? `${value}` : undefined;
}

function genericBindingLines(
  binding: BehaviorBinding,
  behavior: GetBehaviorDetailsResponse | undefined,
  layers: { id: number; name: string }[],
): ReactNode[] {
  const metadata = behavior?.metadata ?? [];
  const param1 = binding.param1 ?? 0;
  const param2 = binding.param2 ?? 0;
  const matchingSet = metadata.find((set) =>
    findValueDescription(param1, set.param1, layers)
  ) ?? metadata[0];

  const lines = [
    parameterLabel(param1, matchingSet?.param1, layers),
    parameterLabel(param2, matchingSet?.param2, layers),
  ].filter((line): line is ReactNode => line !== undefined && line !== "");

  if (lines.length > 0) return lines;
  if (param1 !== 0 || param2 !== 0) return [`${param1}/${param2}`];
  return [];
}

function formatWirelessAction(name: string | undefined, param2: number): string[] {
  const normalized = name?.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  switch (normalized) {
    case "BT_SEL":
    case "BT_SELECT":
    case "SELECT":
    case "SELECT_PROFILE":
      return ["Select", `${param2}`];
    case "BT_DISC":
    case "BT_DISCONNECT":
    case "DISCONNECT":
    case "DISCONNECT_PROFILE":
      return ["Disconnect", `${param2}`];
    case "BT_CLR":
    case "BT_CLEAR":
    case "CLEAR":
    case "CLEAR_PROFILE":
      return ["Clear"];
    case "BT_CLR_ALL":
    case "BT_CLEAR_ALL":
    case "CLEAR_ALL":
    case "CLEAR_ALL_PROFILES":
      return ["Clear", "All"];
    default:
      return name ? name.replace(/^BT_/, "").split("_") : [`${param2}`];
  }
}

function formatWirelessLayerAction(param1: number): string[] {
  return [`BT${param1}`, `L${param1}`];
}

function formatWirelessBaseAction(param1: number): string[] {
  return [`BT${param1}`, "L0"];
}

function StackedLabel({
  lines,
  className = "",
}: {
  lines: ReactNode[];
  className?: string;
}) {
  return (
    <span className={`flex flex-col items-center justify-center gap-0.5 leading-none min-w-0 max-w-full ${className}`}>
      {lines.map((line, i) => (
        <span
          key={i}
          className="block max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-center"
        >
          {line}
        </span>
      ))}
    </span>
  );
}

function bindingContent(
  binding: BehaviorBinding,
  behavior: GetBehaviorDetailsResponse | undefined,
  layers: { id: number; name: string }[],
) {
  if (isBehavior(behavior, ["Transparent"])) {
    return <span className="text-base leading-none">▼</span>;
  }

  if (isBehavior(behavior, ["Layer Tap", "Layer-Tap"])) {
    return (
      <StackedLabel
        className="text-[9px]"
        lines={[
          layerName(layers, binding.param1 ?? 0),
          <span className="opacity-80"><HidUsageLabel hid_usage={binding.param2 ?? 0} /></span>,
        ]}
      />
    );
  }

  if (isBehavior(behavior, ["Bluetooth", "Wireless"])) {
    return (
      <StackedLabel
        className="text-[9px]"
        lines={formatWirelessAction(constantName(behavior, binding.param1 ?? 0), binding.param2 ?? 0)}
      />
    );
  }

  if (isBehavior(behavior, ["Wireless Layer", "bt_layer"])) {
    return (
      <StackedLabel
        className="text-[9px]"
        lines={formatWirelessLayerAction(binding.param1 ?? 0)}
      />
    );
  }

  if (isBehavior(behavior, ["Wireless Base", "bt_base"])) {
    return (
      <StackedLabel
        className="text-[9px]"
        lines={formatWirelessBaseAction(binding.param1 ?? 0)}
      />
    );
  }

  const lines = genericBindingLines(binding, behavior, layers);
  if (lines.length === 0) return <></>;
  return <StackedLabel className="text-[9px]" lines={lines} />;
}

export interface KeymapProps {
  layout: PhysicalLayout;
  keymap: KeymapMsg;
  behaviors: BehaviorMap;
  scale: LayoutZoom;
  selectedLayerIndex: number;
  selectedKeyPosition: number | undefined;
  changedKeyPositions?: Set<number>;
  onKeyPositionClicked: (keyPosition: number) => void;
}

export const Keymap = ({
  layout,
  keymap,
  behaviors,
  scale,
  selectedLayerIndex,
  selectedKeyPosition,
  changedKeyPositions,
  onKeyPositionClicked,
}: KeymapProps) => {
  if (!keymap.layers[selectedLayerIndex]) {
    return <></>;
  }

  const positions = layout.keys.map((k, i) => {
    if (i >= keymap.layers[selectedLayerIndex].bindings.length) {
      return {
        id: `${keymap.layers[selectedLayerIndex].id}-${i}`,
        header: "Unknown",
        x: k.x / 100.0,
        y: k.y / 100.0,
        width: k.width / 100,
        height: k.height / 100.0,
        children: <span></span>,
      };
    }

    const binding = keymap.layers[selectedLayerIndex].bindings[i];
    const behavior = behaviors[binding.behaviorId];

    return {
      id: `${keymap.layers[selectedLayerIndex].id}-${i}`,
      header: behaviorLabel(behavior),
      x: k.x / 100.0,
      y: k.y / 100.0,
      width: k.width / 100,
      height: k.height / 100.0,
      r: (k.r || 0) / 100.0,
      rx: (k.rx || 0) / 100.0,
      ry: (k.ry || 0) / 100.0,
      changed: changedKeyPositions?.has(i) ?? false,
      children: bindingContent(binding, behavior, keymap.layers),
    };
  });

  return (
    <PhysicalLayoutComp
      positions={positions}
      oneU={48}
      hoverZoom={true}
      zoom={scale}
      selectedPosition={selectedKeyPosition}
      onPositionClicked={onKeyPositionClicked}
    />
  );
};
