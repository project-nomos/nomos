import React, { useState, useCallback, useMemo, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { SLASH_COMMANDS } from "../slash-commands.ts";
import { theme } from "../theme.ts";

const MAX_SUGGESTIONS = 8;

interface CommandInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focus?: boolean;
  prompt: string;
}

export function CommandInput({
  value,
  onChange,
  onSubmit,
  focus = true,
  prompt,
}: CommandInputProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Incrementing key forces TextInput to re-mount after completion,
  // which resets its internal cursor to the end of the new value.
  const [inputKey, setInputKey] = useState(0);

  // Ref tracks the latest value synchronously so Enter always submits
  // the current text, even if Tab completion and Enter arrive in the
  // same stdin chunk (before React re-renders with the new prop).
  const valueRef = useRef(value);
  valueRef.current = value;

  // Compute filtered suggestions when input starts with "/"
  const suggestions = useMemo(() => {
    if (!value.startsWith("/")) return [];
    const partial = value.slice(1).toLowerCase();
    // Show all commands when just "/" is typed
    if (partial === "") return SLASH_COMMANDS.slice(0, MAX_SUGGESTIONS);
    const filtered = SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(partial));
    // Auto-dismiss when exact match is fully typed
    if (filtered.length === 1 && filtered[0].name === partial) return [];
    return filtered.slice(0, MAX_SUGGESTIONS);
  }, [value]);

  const showDropdown = suggestions.length > 0;

  // Reset selection index when suggestions change
  const prevSuggestionsLength = useRef(suggestions.length);
  if (suggestions.length !== prevSuggestionsLength.current) {
    prevSuggestionsLength.current = suggestions.length;
    if (selectedIndex >= suggestions.length) {
      setSelectedIndex(Math.max(0, suggestions.length - 1));
    }
  }

  /** Apply a completion: update value, ref, and re-mount TextInput. */
  const applyCompletion = useCallback(
    (completed: string) => {
      onChange(completed);
      valueRef.current = completed;
      setSelectedIndex(0);
      setInputKey((k) => k + 1);
    },
    [onChange],
  );

  const handleChange = useCallback(
    (newValue: string) => {
      onChange(newValue);
      valueRef.current = newValue;
      setSelectedIndex(0);
    },
    [onChange],
  );

  // Handle Enter + dropdown navigation (arrow keys, Tab, Escape).
  // Enter is intercepted here (instead of TextInput's onSubmit) so we
  // always submit valueRef.current — which stays in sync even when a
  // Tab-completion and Enter land in the same stdin data chunk.
  useInput(
    (input, key) => {
      if (key.return) {
        if (showDropdown) {
          // Dropdown visible → complete the highlighted suggestion (don't submit).
          // User can then add arguments or press Enter again to execute.
          const selected = suggestions[selectedIndex];
          if (selected) {
            applyCompletion(`/${selected.name} `);
          }
          return;
        }
        // No dropdown → submit
        setSelectedIndex(0);
        onSubmit(valueRef.current);
        return;
      }

      if (!showDropdown) return;

      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
      } else if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
      } else if (key.tab) {
        const selected = suggestions[selectedIndex];
        if (selected) {
          applyCompletion(`/${selected.name} `);
        }
      } else if (key.escape) {
        onChange("");
        valueRef.current = "";
        setSelectedIndex(0);
      }
    },
    { isActive: focus },
  );

  return (
    <Box flexDirection="column">
      {/* Input line — onSubmit intentionally omitted; Enter is handled
          in the useInput hook above for correct value tracking. */}
      <Box>
        <Text color={theme.text.user} bold>
          {prompt}
        </Text>
        <TextInput key={inputKey} value={value} onChange={handleChange} focus={focus} />
      </Box>

      {/* Dropdown suggestions */}
      {showDropdown && (
        <Box flexDirection="column" marginLeft={2}>
          {suggestions.map((cmd, i) => {
            const isSelected = i === selectedIndex;
            return (
              <Box key={cmd.name}>
                <Text color={theme.border.focused}>{"  \u2503 "}</Text>
                <Text
                  color={isSelected ? theme.text.link : undefined}
                  bold={isSelected}
                  dimColor={!isSelected}
                >
                  {"/" + cmd.name.padEnd(12)}
                </Text>
                <Text dimColor>{cmd.desc}</Text>
                {isSelected && <Text color={theme.text.secondary}>{" \u2190"}</Text>}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
