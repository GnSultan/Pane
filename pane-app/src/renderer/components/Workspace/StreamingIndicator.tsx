interface StreamingIndicatorProps {
  isStreaming: boolean;
  isReasoning?: boolean;
  provider?: string;
  size?: "sm" | "md";
}

const Dot = ({ 
  color, 
  delay, 
  size = "md" 
}: { 
  color: string; 
  delay: number; 
  size?: "sm" | "md" 
}) => (
  <div
    className={`${size === "sm" ? "w-1 h-1" : "w-1.5 h-1.5"} rounded-full ${color}`}
    style={{
      animation: `breathe 4s ease-in-out infinite`,
      animationDelay: `${delay}s`,
      opacity: 0.3,
    }}
  />
);

function getIndicatorColor(isReasoning: boolean, provider: string) {
  if (isReasoning) return "bg-pane-text-secondary/60";
  
  switch (provider) {
    case "deepseek":
      return "bg-pane-terminal";
    case "anthropic":
      return "bg-pane-text-secondary";
    case "kimi":
      return "bg-pane-text-secondary/70";
    default:
      return "bg-pane-text-secondary/50";
  }
}

export function StreamingIndicator({
  isStreaming,
  isReasoning = false,
  provider = "deepseek",
}: StreamingIndicatorProps) {
  if (!isStreaming) return null;

  const color = getIndicatorColor(isReasoning, provider);

  return (
    <div className="flex items-center gap-2 my-2 py-1 animate-fadeIn">
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <Dot key={i} color={color} delay={i * 0.6} />
        ))}
      </div>
    </div>
  );
}

// Compact version for inline use
export function CompactStreamingIndicator({
  isStreaming,
  isReasoning = false,
  provider = "deepseek",
}: StreamingIndicatorProps) {
  if (!isStreaming) return null;

  const color = getIndicatorColor(isReasoning, provider);

  return (
    <div className="flex items-center gap-1 animate-fadeIn">
      <div className="flex items-center gap-1">
        {isReasoning ? (
          [0, 1, 2].map((i) => (
            <Dot key={i} color={color} delay={i * 0.4} size="sm" />
          ))
        ) : (
          <Dot color={color} delay={0} size="sm" />
        )}
      </div>
    </div>
  );
}
