import { useCallback, useMemo } from "react";
import {
  hid_usage_from_page_and_id,
  hid_usage_get_labels,
} from "../hid-usages";

export interface HidUsagePage {
  id: number;
  min?: number;
  max?: number;
}

export interface HidUsagePickerProps {
  label?: string;
  value?: number;
  usagePages: HidUsagePage[];
  onValueChanged: (value?: number) => void;
}

enum Mods {
  LeftControl  = 0x01,
  LeftShift    = 0x02,
  LeftAlt      = 0x04,
  LeftGUI      = 0x08,
  RightControl = 0x10,
  RightShift   = 0x20,
  RightAlt     = 0x40,
  RightGUI     = 0x80,
}

const MOD_LABELS: Record<number, string> = {
  [Mods.LeftControl]:  "L Ctrl",
  [Mods.LeftShift]:    "L Shift",
  [Mods.LeftAlt]:      "L Alt",
  [Mods.LeftGUI]:      "L GUI",
  [Mods.RightControl]: "R Ctrl",
  [Mods.RightShift]:   "R Shift",
  [Mods.RightAlt]:     "R Alt",
  [Mods.RightGUI]:     "R GUI",
};

const ALL_MODS: Mods[] = [
  Mods.LeftControl,
  Mods.LeftShift,
  Mods.LeftAlt,
  Mods.LeftGUI,
  Mods.RightControl,
  Mods.RightShift,
  Mods.RightAlt,
  Mods.RightGUI,
];

interface KeySection {
  label: string;
  page: number;
  ids: number[];
}

const KB_SECTIONS: KeySection[] = [
  {
    label: "Letters",
    page: 7,
    ids: [...Array(26)].map((_, i) => i + 4), // a=4 … z=29
  },
  {
    label: "Numbers",
    page: 7,
    ids: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39], // 1-0
  },
  {
    label: "F Keys",
    page: 7,
    ids: [58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
          104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115], // F1-F24
  },
  {
    label: "Navigation",
    page: 7,
    // Up Left Down Right / Home PgUp End PgDn
    ids: [82, 80, 81, 79, 74, 75, 77, 78],
  },
  {
    label: "Special",
    page: 7,
    ids: [41, 43, 57, 44, 40, 42, 73, 76,  // Esc Tab CapsLk Space Enter BkSp Ins Del
          45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56, // - = [ ] \ ; ' ` , . /
          70, 71, 72],                                   // PrtSc ScrLk Pause
  },
  {
    label: "Key Mod",
    page: 7,
    ids: [0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7],
  },
  {
    label: "Media",
    page: 12,
    ids: [181, 182, 183, 180, 179, 205, 226, 233, 234, 184],
    // Next Prev Stop Rew FF PlayPause Mute VolUp VolDn Eject
  },
];

function getMods(value: number): number {
  return (value >> 24) & 0xff;
}

function getKey(value: number): number {
  return value & 0x00ffffff;
}

function keyLabel(page: number, id: number): string {
  const labels = hid_usage_get_labels(page & 0xff, id);
  const raw = labels.short || labels.med || labels.long || "";
  return raw.replace(/^Keyboard /, "");
}

export const HidUsagePicker = ({
  label,
  value,
  usagePages,
  onValueChanged,
}: HidUsagePickerProps) => {
  const currentMods = value ? getMods(value) : 0;
  const currentKey  = value ? getKey(value)  : 0;

  const toggleMod = useCallback(
    (mod: Mods) => {
      if (!value) return;
      const newMods = currentMods ^ mod;
      onValueChanged(currentKey | (newMods << 24));
    },
    [value, currentMods, currentKey, onValueChanged]
  );

  const selectKey = useCallback(
    (page: number, id: number) => {
      const usage = hid_usage_from_page_and_id(page, id);
      onValueChanged(usage | (currentMods << 24));
    },
    [currentMods, onValueChanged]
  );

  const visibleSections = useMemo(() => {
    return KB_SECTIONS.map((section) => {
      const pageSpec = usagePages.find((p) => p.id === section.page);
      if (!pageSpec) return null;

      const filteredIds = section.ids.filter((id) => {
        // modifier keys are always included for keyboard page
        if (section.page === 7 && id >= 0xe0 && id <= 0xe7) return true;
        return (
          id >= (pageSpec.min ?? 0) &&
          id <= (pageSpec.max ?? 0xffff)
        );
      });

      return filteredIds.length > 0 ? { ...section, ids: filteredIds } : null;
    }).filter(Boolean) as KeySection[];
  }, [usagePages]);

  return (
    <div className="flex flex-col gap-3">
      {label && (
        <div className="text-sm text-base-content/50 font-semibold uppercase tracking-wider">
          {label}
        </div>
      )}

      {/* Implicit modifier toggles */}
      <div>
        <div className="text-[10px] text-base-content/40 uppercase tracking-wider mb-1">
          Modifiers
        </div>
        <div className="flex flex-wrap gap-1">
          {ALL_MODS.map((mod) => (
            <button
              key={mod}
              disabled={!value}
              className={`px-2.5 py-1.5 text-sm rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                currentMods & mod
                  ? "bg-primary text-primary-content"
                  : "bg-base-300 text-base-content hover:bg-base-100"
              }`}
              onClick={() => toggleMod(mod)}
            >
              {MOD_LABELS[mod]}
            </button>
          ))}
        </div>
      </div>

      {/* Key grid sections */}
      {visibleSections.map((section) => (
        <div key={section.label}>
          <div className="text-sm text-base-content/40 uppercase tracking-wider mb-1">
            {section.label}
          </div>
          <div className="flex flex-wrap gap-1">
            {section.ids.map((id) => {
              const usage = hid_usage_from_page_and_id(section.page, id);
              const isSelected = currentKey === usage;
              const lbl = keyLabel(section.page, id);
              return (
                <button
                  key={id}
                  title={lbl}
                  className={`min-w-[2.5rem] px-2 py-1.5 text-sm rounded border transition-colors text-center leading-none ${
                    isSelected
                      ? "bg-primary text-primary-content border-primary shadow"
                      : "bg-base-100 text-base-content border-base-300 hover:border-primary hover:bg-base-200"
                  }`}
                  onClick={() => selectKey(section.page, id)}
                >
                  {lbl || id}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
