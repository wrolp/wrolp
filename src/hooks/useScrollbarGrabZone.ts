import { useEffect, useState, type RefObject } from 'react'

/**
 * Reports whether the pointer sits inside the vertical scrollbar grab zone —
 * the rightmost `zone` px of `target`.
 *
 * Thin overlay scrollbars (4–5px) are painful to hit with a mouse, so callers
 * widen the bar while the pointer is near it and restore the slim width once it
 * leaves. Pointer moves are coalesced into a single animation frame and the
 * state only flips on zone entry/exit, so this costs one re-render per
 * transition rather than one per mouse move.
 *
 * Bind this to a container that stays mounted for the component's whole life;
 * the listeners are attached once on mount.
 */
export function useScrollbarGrabZone(
  target: RefObject<HTMLElement | null>,
  zone = 14,
): boolean {
  const [near, setNear] = useState(false)

  useEffect(() => {
    const el = target.current
    if (!el) return
    let raf = 0
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect()
        setNear(e.clientX >= rect.right - zone)
      })
    }
    const onLeave = () => {
      cancelAnimationFrame(raf)
      setNear(false)
    }
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
    }
  }, [target, zone])

  return near
}
