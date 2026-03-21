

interface MicroIndicatorProps {
  /**
   * The visual style of the indicator
   * @default "subtle"
   */
  variant?: "subtle" | "strong" | "error" | "success";
  /**
   * Whether the indicator should pulse (animate)
   * @default true
   */
  animate?: boolean;
  /**
   * Additional CSS classes to apply
   */
  className?: string;
  /**
   * Size of the indicator in pixels
   * @default 6
   */
  size?: number;
  /**
   * Optional label for screen readers
   */
  ariaLabel?: string;
  /**
   * Optional tooltip text
   */
  tooltip?: string;
}

/**
 * MicroIndicator - A subtle visual indicator for processing states
 * 
 * Used throughout Pane to provide context-specific feedback without
 * disrupting the clean, minimal aesthetic.
 * 
 * Design principles:
 * - Subtle and non-intrusive
 * - Consistent sizing and animation
 * - Semantic colors that convey meaning
 * - Accessible with proper ARIA labels
 */
export function MicroIndicator({
  variant = "subtle",
  animate = true,
  className = "",
  size = 6,
  ariaLabel,
  tooltip,
}: MicroIndicatorProps) {
  const baseClasses = "inline-block rounded-full shrink-0";
  
  const variantClasses = {
    subtle: "bg-pane-text-secondary/30",
    strong: "bg-pane-text-secondary/60",
    error: "bg-pane-error/70",
    success: "bg-pane-status-added/70",
  };

  const animateClasses = animate ? "animate-pulse" : "";
  const sizeStyle = { width: size, height: size };

  const indicator = (
    <span
      className={`${baseClasses} ${variantClasses[variant]} ${animateClasses} ${className}`}
      style={sizeStyle}
      role="status"
      aria-label={ariaLabel || `Processing indicator: ${variant}`}
      data-tooltip={tooltip}
    />
  );

  if (tooltip) {
    return (
      <span className="relative group">
        {indicator}
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 
                         opacity-0 group-hover:opacity-100 transition-opacity
                         bg-pane-bg text-pane-text text-xs px-2 py-1 rounded
                         pointer-events-none whitespace-nowrap z-10 ring-1 ring-pane-border/40"
              style={{ fontSize: "var(--pane-font-size-xs)" }}>
          {tooltip}
        </span>
      </span>
    );
  }

  return indicator;
}

export default MicroIndicator;