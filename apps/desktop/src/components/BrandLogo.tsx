export function BrandLogo({ size = 16 }: { size?: number }) {
  return (
    <span
      className="brand-logo"
      aria-hidden="true"
      style={{ width: size, height: size }}
    />
  );
}
