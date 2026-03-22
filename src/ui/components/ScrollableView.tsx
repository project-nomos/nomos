import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";

interface ScrollableViewProps {
  /** All rendered items as React elements */
  children: React.ReactNode[];
  /** Terminal height in rows */
  height: number;
}

/**
 * A scrollable viewport for rendered items.
 * Supports Page Up/Down, Home/End navigation.
 * Used when alternate buffer mode is enabled.
 */
export function ScrollableView({ children, height }: ScrollableViewProps): React.ReactElement {
  const totalItems = children.length;
  const [scrollOffset, setScrollOffset] = useState(0);

  // Keep scroll near the bottom when new items arrive
  const maxOffset = Math.max(0, totalItems - 1);

  const scrollUp = useCallback((amount: number) => {
    setScrollOffset((prev) => Math.max(0, prev - amount));
  }, []);

  const scrollDown = useCallback(
    (amount: number) => {
      setScrollOffset((prev) => Math.min(maxOffset, prev + amount));
    },
    [maxOffset],
  );

  useInput((_input, key) => {
    if (key.pageUp) {
      scrollUp(Math.floor(height / 2));
    } else if (key.pageDown) {
      scrollDown(Math.floor(height / 2));
    } else if (key.home) {
      setScrollOffset(0);
    } else if (key.end) {
      setScrollOffset(maxOffset);
    }
  });

  // Determine which items to render based on viewport
  // We show items starting from scrollOffset, limited by what fits
  const visibleItems = children.slice(scrollOffset);

  const atTop = scrollOffset === 0;
  const atBottom = scrollOffset >= maxOffset;

  return (
    <Box flexDirection="column" height={height}>
      {/* Scroll indicator */}
      {!atTop && (
        <Box justifyContent="flex-end">
          <Text dimColor>↑ {scrollOffset} items above (PgUp/Home)</Text>
        </Box>
      )}

      {/* Visible content */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleItems}
      </Box>

      {/* Bottom indicator */}
      {!atBottom && totalItems > 0 && (
        <Box justifyContent="flex-end">
          <Text dimColor>↓ {totalItems - scrollOffset - 1} items below (PgDn/End)</Text>
        </Box>
      )}
    </Box>
  );
}
