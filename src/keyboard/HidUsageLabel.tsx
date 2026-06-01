import {
  hid_usage_get_labels,
  hid_usage_page_and_id_from_usage,
} from "../hid-usages";

export interface HidUsageLabelProps {
  hid_usage: number;
}

function remove_prefix(s?: string) {
  return s?.replace(/^Keyboard /, "");
}

const MOD_LABELS: Array<[number, string]> = [
  [0x01, "lC"],
  [0x02, "lS"],
  [0x04, "lA"],
  [0x08, "lG"],
  [0x10, "rC"],
  [0x20, "rS"],
  [0x40, "rA"],
  [0x80, "rG"],
];

function modsLabel(mods: number): string {
  return MOD_LABELS
    .filter(([mask]) => (mods & mask) !== 0)
    .map(([, label]) => label)
    .join(" + ");
}

export const HidUsageLabel = ({ hid_usage }: HidUsageLabelProps) => {
  const mods = (hid_usage >> 24) & 0xff;
  const usage = hid_usage & 0x00ffffff;
  let [page, id] = hid_usage_page_and_id_from_usage(usage);

  page &= 0xff;

  let labels = hid_usage_get_labels(page, id);
  const shortLabel = remove_prefix(labels.short);
  const longLabel = remove_prefix(labels.long || labels.med || labels.short);
  const modPrefix = modsLabel(mods);
  const keyLabel = shortLabel || longLabel || "";

  return (
    <span
      className="inline-flex max-w-full flex-col items-center justify-center whitespace-normal break-words [overflow-wrap:anywhere] text-center leading-none"
      title={modPrefix ? `(${modPrefix}) ${longLabel || keyLabel}` : longLabel || keyLabel}
    >
      {modPrefix && (
        <span className="text-[7px] opacity-75 leading-none">
          ({modPrefix})
        </span>
      )}
      <span className="leading-none">{keyLabel}</span>
    </span>
  );
};
