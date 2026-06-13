"use client";

import { useEffect, useRef } from "react";

export function RichTextEditor({
  value,
  onChange,
  mergeFields = [],
  placeholder,
}: {
  value: string;
  onChange: (html: string) => void;
  mergeFields?: string[];
  placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Initialize the editable region once; afterwards it's uncontrolled so the
  // caret never jumps. The parent stays in sync via onInput.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value || "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function emit() {
    if (ref.current) onChange(ref.current.innerHTML);
  }

  function cmd(command: string, val?: string) {
    ref.current?.focus();
    document.execCommand(command, false, val);
    emit();
  }

  function insertTag(field: string) {
    ref.current?.focus();
    document.execCommand("insertText", false, `{{${field}}}`);
    emit();
  }

  function addLink() {
    const url = window.prompt("Link URL", "https://");
    if (url) cmd("createLink", url);
  }

  return (
    <div className="rounded-lg border border-neutral-300">
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-200 p-2">
        <Btn onClick={() => cmd("bold")} title="Bold">
          <b>B</b>
        </Btn>
        <Btn onClick={() => cmd("italic")} title="Italic">
          <i>I</i>
        </Btn>
        <Btn onClick={() => cmd("underline")} title="Underline">
          <u>U</u>
        </Btn>
        <Btn onClick={() => cmd("insertUnorderedList")} title="Bulleted list">
          • List
        </Btn>
        <Btn onClick={addLink} title="Insert link">
          Link
        </Btn>
        {mergeFields.length > 0 && (
          <>
            <span className="mx-1 h-4 w-px bg-neutral-200" />
            {mergeFields.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => insertTag(f)}
                className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs hover:bg-neutral-200"
              >{`{{${f}}}`}</button>
            ))}
          </>
        )}
      </div>
      <div
        ref={ref}
        contentEditable
        onInput={emit}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        className="min-h-[200px] px-3 py-2 text-sm leading-relaxed focus:outline-none [&:empty:before]:text-neutral-400 [&:empty:before]:content-[attr(data-placeholder)]"
      />
    </div>
  );
}

function Btn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded px-2 py-1 text-sm hover:bg-neutral-100"
    >
      {children}
    </button>
  );
}
