/** Единый набор инструментальных иконок: монохром (currentColor), один стиль. */

function Svg(props: { children: React.ReactNode; filled?: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill={props.filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.children}
    </svg>
  )
}

export const IconBrush = (): React.JSX.Element => (
  <Svg>
    <path d="M14.5 2.5 L17.5 5.5 L9 14 L5.5 14.5 L6 11 Z" />
    <path d="M5.5 14.5 C4 15 3 16.5 2.5 17.5 C4.5 17.5 6.5 17 7.2 15.6" />
  </Svg>
)

export const IconEraser = (): React.JSX.Element => (
  <Svg>
    <path d="M7.5 16.5 L3 12 L11 4 L16.5 9.5 L9.5 16.5 Z" />
    <line x1="7" y1="8" x2="12.5" y2="13.5" />
    <line x1="9.5" y1="16.5" x2="17" y2="16.5" />
  </Svg>
)

export const IconMarqueeRect = (): React.JSX.Element => (
  <Svg>
    <path d="M3 3 h3 M8 3 h4 M14 3 h3 M17 3 v3 M17 8 v4 M17 14 v3 M17 17 h-3 M12 17 h-4 M6 17 h-3 M3 17 v-3 M3 12 v-4 M3 6 v-3" />
  </Svg>
)

export const IconMarqueeEllipse = (): React.JSX.Element => (
  <Svg>
    <path d="M10 3 a7 5.5 0 0 1 4.9 1.6 M17 8.5 a7 5.5 0 0 1 -1.4 5.4 M12.5 15.7 a7 5.5 0 0 1 -5 0 M4.4 13.9 A7 5.5 0 0 1 3 8.5 M5.1 4.6 A7 5.5 0 0 1 10 3" />
  </Svg>
)

export const IconLasso = (): React.JSX.Element => (
  <Svg>
    <path d="M10 3 C14.5 3 17.5 5 17.5 8 C17.5 11 14.5 13 10 13 C7.8 13 6 12.4 4.8 11.5" />
    <path d="M4.8 11.5 C3.6 10.7 3 9.5 3 8 C3 5 6 3 10 3" />
    <path d="M4.8 11.5 C4 12.5 4.5 14 6 14 C7 14 7.5 13.3 7.3 12.6" />
    <path d="M6 14 C6 15.5 5.5 16.5 4.5 17.5" />
  </Svg>
)

export const IconWand = (): React.JSX.Element => (
  <Svg>
    <path d="M11 9 L17 15" />
    <path d="M7.5 5.5 L9.5 7.5" />
    <path d="M5 11 L3.5 12.5 M8 2.5 L8 4.5 M3 7.5 L5 7.5 M12 4 L13.5 2.5" />
    <path d="M6.5 8.5 L9 6 L11.5 8.5 L9 11 Z" />
  </Svg>
)

export const IconSam = (): React.JSX.Element => (
  <Svg>
    <circle cx="10" cy="10" r="6.5" strokeDasharray="3 2.2" />
    <circle cx="10" cy="10" r="1.4" fill="currentColor" />
    <path d="M10 1.5 v2 M10 16.5 v2 M1.5 10 h2 M16.5 10 h2" />
  </Svg>
)

export const IconText = (): React.JSX.Element => (
  <Svg>
    <path d="M4 5.5 V4 H16 V5.5 M10 4 V16 M8 16 H12" />
  </Svg>
)

export const IconCrop = (): React.JSX.Element => (
  <Svg>
    <path d="M6 2.5 V14 H17.5 M2.5 6 H14 V17.5" />
  </Svg>
)

export const IconHand = (): React.JSX.Element => (
  <Svg>
    <path d="M7 10 V4.8 a1.1 1.1 0 0 1 2.2 0 V9 M9.2 9 V3.6 a1.1 1.1 0 0 1 2.2 0 V9 M11.4 9 V4.6 a1.1 1.1 0 0 1 2.2 0 V10.5" />
    <path d="M13.6 10.5 c0.4 -1.4 2 -1.6 2.6 -0.4 c0.4 0.9 -0.3 2.4 -1.2 4.4 c-0.9 2 -2.4 3 -4.6 3 c-2.6 0 -3.8 -1 -4.8 -3.2 L4 11.2 c-0.6 -1.3 1 -2.3 2 -1.3 L7 11" />
  </Svg>
)

export const IconMove = (): React.JSX.Element => (
  <Svg>
    <path d="M10 2.5 V17.5 M2.5 10 H17.5" />
    <path d="M8 4.5 L10 2.5 L12 4.5 M8 15.5 L10 17.5 L12 15.5 M4.5 8 L2.5 10 L4.5 12 M15.5 8 L17.5 10 L15.5 12" />
  </Svg>
)

export const IconGear = (): React.JSX.Element => (
  <Svg>
    <circle cx="10" cy="10" r="2.6" />
    <path d="M10 2.8 v2 M10 15.2 v2 M2.8 10 h2 M15.2 10 h2 M4.9 4.9 l1.4 1.4 M13.7 13.7 l1.4 1.4 M15.1 4.9 l-1.4 1.4 M6.3 13.7 l-1.4 1.4" />
  </Svg>
)

export const IconChevron = (): React.JSX.Element => (
  <svg viewBox="0 0 8 8" width="7" height="7" fill="currentColor">
    <path d="M1 1 L7 4 L1 7 Z" />
  </svg>
)
