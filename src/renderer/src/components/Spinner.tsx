/** Small indeterminate loading spinner (honours the reduce-motion setting). */
export function Spinner({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  )
}
