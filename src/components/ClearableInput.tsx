import React from 'react'

interface ClearableInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
> {
  value: string
  /** Called with the new string value; receives `''` when cleared. */
  onValueChange: (value: string) => void
  /** Element pinned inside the field (e.g. the password show/hide eye). The
   *  clear button shifts left to make room for it. */
  trailing?: React.ReactNode
  /** Extra classes for the wrapper element. */
  className?: string
  /** Inline style for the **wrapper** (a `style` prop goes to the input). */
  wrapperStyle?: React.CSSProperties
}

/**
 * Text input with a clear (✕) button.
 *
 * The button is only rendered while the field is non-empty, and stays hidden
 * until the field is hovered or focused (see `.clearable-input` in App.scss) so
 * it does not add permanent visual noise to dense forms.
 *
 * Clearing goes through `onMouseDown` + `preventDefault` — an `onClick` handler
 * would let the button take focus and blur the input first.
 */
export const ClearableInput: React.FC<ClearableInputProps> = ({
  value,
  onValueChange,
  trailing,
  className,
  wrapperStyle,
  ...rest
}) => {
  const classes = ['clearable-input']
  if (trailing) classes.push('with-trailing')
  if (className) classes.push(className)

  return (
    <div className={classes.join(' ')} style={wrapperStyle}>
      <input {...rest} value={value} onChange={(e) => onValueChange(e.target.value)} />
      {trailing}
      {value !== '' && (
        <button
          type="button"
          className="input-clear-btn"
          title="Clear"
          aria-label="Clear"
          onMouseDown={(e) => {
            e.preventDefault()
            onValueChange('')
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}

export default ClearableInput
