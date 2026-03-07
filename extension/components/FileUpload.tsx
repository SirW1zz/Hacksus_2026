import React, { useRef } from "react";

interface Props {
  onFileSelect: (file: File) => void;
  accept?: string;
  selectedFile?: File | null;
  label?: string;
}

export default function FileUpload({
  onFileSelect,
  accept = ".pdf",
  selectedFile,
  label = "Click to select file",
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="file-drop" onClick={() => fileRef.current?.click()}>
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFileSelect(file);
        }}
      />
      {selectedFile ? (
        <span className="file-name">✅ {selectedFile.name}</span>
      ) : (
        <span>{label}</span>
      )}
    </div>
  );
}
