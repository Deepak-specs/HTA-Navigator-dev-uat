// src/components/DownloadCloudIcon.jsx
export default function DownloadCloudIcon({ size = 24, color = "#7B1F4B", arrowColor = "#fff" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ flex: "0 0 auto" }}
    >
      <path
        fill={color}
        d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"
      />
      <path fill={arrowColor} d="M12 17l4-4h-3V9h-2v4H8z" />
    </svg>
  );
}