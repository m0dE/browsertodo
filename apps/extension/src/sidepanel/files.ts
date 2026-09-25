/** File attachments: a picker with removable chips, and base64 conversion for the protocol. */
import { formatBytes } from "@browsertodo/shared";
import type { UiMediaUpload } from "../ui-protocol.js";
import { h } from "../ui/dom.js";
import { bytesToBase64 } from "./format.js";

export async function filesToUploads(files: File[]): Promise<UiMediaUpload[]> {
  return Promise.all(
    files.map(async (f) => ({
      name: f.name,
      type: f.type || "application/octet-stream",
      dataBase64: bytesToBase64(new Uint8Array(await f.arrayBuffer())),
    })),
  );
}

export interface FilePicker {
  files(): File[];
  clear(): void;
}

/** Wire an <input type=file multiple> to a chip list; picking again adds to the selection. */
export function filePicker(input: HTMLInputElement, list: HTMLElement, onChange?: () => void): FilePicker {
  let files: File[] = [];
  const render = () => {
    onChange?.();
    list.replaceChildren(
      ...files.map((f, i) =>
        h(
          "li",
          { title: `${f.name} (${formatBytes(f.size)})` },
          h("span", null, f.name),
          h("button", {
            type: "button",
            "aria-label": `Remove ${f.name}`,
            onclick: () => {
              files = files.filter((_, j) => j !== i);
              render();
            },
          }, "×"),
        ),
      ),
    );
  };
  input.addEventListener("change", () => {
    files = [...files, ...Array.from(input.files ?? [])];
    input.value = "";
    render();
  });
  return {
    files: () => files,
    clear: () => {
      files = [];
      render();
    },
  };
}
