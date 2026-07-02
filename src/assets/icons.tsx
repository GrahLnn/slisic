import { motion } from "motion/react";
import type { ComponentProps } from "react";

interface IconProps extends Omit<ComponentProps<typeof motion.svg>, "color"> {
  size?: number;
  color?: string;
  pathMotion?: Pick<
    ComponentProps<typeof motion.path>,
    "initial" | "animate" | "exit" | "transition"
  >;
}

export const logos = {
  tauri({ color, className, ...props }: IconProps) {
    return (
      <motion.svg
        width="206"
        height="231"
        viewBox="0 0 206 231"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        {...props}
      >
        <path
          d="M143.143 84C143.143 96.1503 133.293 106 121.143 106C108.992 106 99.1426 96.1503 99.1426 84C99.1426 71.8497 108.992 62 121.143 62C133.293 62 143.143 71.8497 143.143 84Z"
          fill={color || "currentColor"}
        />
        <ellipse
          cx="84.1426"
          cy="147"
          rx="22"
          ry="22"
          transform="rotate(180 84.1426 147)"
          fill="#24C8DB"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M166.738 154.548C157.86 160.286 148.023 164.269 137.757 166.341C139.858 160.282 141 153.774 141 147C141 144.543 140.85 142.121 140.558 139.743C144.975 138.204 149.215 136.139 153.183 133.575C162.73 127.404 170.292 118.608 174.961 108.244C179.63 97.8797 181.207 86.3876 179.502 75.1487C177.798 63.9098 172.884 53.4021 165.352 44.8883C157.82 36.3744 147.99 30.2165 137.042 27.1546C126.095 24.0926 114.496 24.2568 103.64 27.6274C92.7839 30.998 83.1319 37.4317 75.8437 46.1553C74.9102 47.2727 74.0206 48.4216 73.176 49.5993C61.9292 50.8488 51.0363 54.0318 40.9629 58.9556C44.2417 48.4586 49.5653 38.6591 56.679 30.1442C67.0505 17.7298 80.7861 8.57426 96.2354 3.77762C111.685 -1.01901 128.19 -1.25267 143.769 3.10474C159.348 7.46215 173.337 16.2252 184.056 28.3411C194.775 40.457 201.767 55.4101 204.193 71.404C206.619 87.3978 204.374 103.752 197.73 118.501C191.086 133.25 180.324 145.767 166.738 154.548ZM41.9631 74.275L62.5557 76.8042C63.0459 72.813 63.9401 68.9018 65.2138 65.1274C57.0465 67.0016 49.2088 70.087 41.9631 74.275Z"
          fill={color || "currentColor"}
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M38.4045 76.4519C47.3493 70.6709 57.2677 66.6712 67.6171 64.6132C65.2774 70.9669 64 77.8343 64 85.0001C64 87.1434 64.1143 89.26 64.3371 91.3442C60.0093 92.8732 55.8533 94.9092 51.9599 97.4256C42.4128 103.596 34.8505 112.392 30.1816 122.756C25.5126 133.12 23.9357 144.612 25.6403 155.851C27.3449 167.09 32.2584 177.598 39.7906 186.112C47.3227 194.626 57.153 200.784 68.1003 203.846C79.0476 206.907 90.6462 206.743 101.502 203.373C112.359 200.002 122.011 193.568 129.299 184.845C130.237 183.722 131.131 182.567 131.979 181.383C143.235 180.114 154.132 176.91 164.205 171.962C160.929 182.49 155.596 192.319 148.464 200.856C138.092 213.27 124.357 222.426 108.907 227.222C93.458 232.019 76.9524 232.253 61.3736 227.895C45.7948 223.538 31.8055 214.775 21.0867 202.659C10.3679 190.543 3.37557 175.59 0.949823 159.596C-1.47592 143.602 0.768139 127.248 7.41237 112.499C14.0566 97.7497 24.8183 85.2327 38.4045 76.4519ZM163.062 156.711L163.062 156.711C162.954 156.773 162.846 156.835 162.738 156.897C162.846 156.835 162.954 156.773 163.062 156.711Z"
          fill={color || "currentColor"}
        />
      </motion.svg>
    );
  },
};

export const icons = {
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9IiMyMTIxMjEiPjxwYXRoIGQ9Ik04IDJMMTYgMiIgc3Ryb2tlPSIjMjEyMTIxIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJzcXVhcmUiIGZpbGw9Im5vbmUiPjwvcGF0aD48cGF0aCBkPSJNNiA0TDYgNC4wMSIgc3Ryb2tlPSIjMjEyMTIxIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJzcXVhcmUiIGZpbGw9Im5vbmUiPjwvcGF0aD48cGF0aCBkPSJNMTguMDEgNEwxOCA0IiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjxwYXRoIGQ9Ik00IDZMNCA2LjAxIiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjxwYXRoIGQ9Ik0yMC4wMSA2TDIwIDYiIHN0cm9rZT0iIzIxMjEyMSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0ic3F1YXJlIiBmaWxsPSJub25lIj48L3BhdGg+PHBhdGggZD0iTTIgOEwyIDE2IiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjxwYXRoIGQ9Ik0yMiA4TDIyIDE2IiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjxwYXRoIGQ9Ik00LjAxMDAxIDE4TDQuMDAwMDEgMTgiIHN0cm9rZT0iIzIxMjEyMSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0ic3F1YXJlIiBmaWxsPSJub25lIj48L3BhdGg+PHBhdGggZD0iTTIwLjAxIDE4TDIwIDE4IiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjxwYXRoIGQ9Ik02LjAxMDAxIDIwTDYuMDAwMDEgMjAiIHN0cm9rZT0iIzIxMjEyMSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0ic3F1YXJlIiBmaWxsPSJub25lIj48L3BhdGg+PHBhdGggZD0iTTE4LjAxIDIwTDE4IDIwIiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjxwYXRoIGQ9Ik04IDIyTDE2IDIyIiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjxwYXRoIGQ9Ik0xNS4wMSAxMEwxNSAxMCIgc3Ryb2tlPSIjMjEyMTIxIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJzcXVhcmUiIGZpbGw9Im5vbmUiPjwvcGF0aD48cGF0aCBkPSJNMTQgMTZMOS41IDE2TDkuNSAxMCIgc3Ryb2tlPSIjMjEyMTIxIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJzcXVhcmUiIGZpbGw9Im5vbmUiPjwvcGF0aD48cGF0aCBkPSJNMTEuNSA4SDEzIiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjxwYXRoIGQ9Ik04IDEySDExIiBzdHJva2U9IiMyMTIxMjEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InNxdWFyZSIgZmlsbD0ibm9uZSI+PC9wYXRoPjwvZz48L3N2Zz4=)
   * @returns
   */
  circleSterling({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 24}
        height={size || 24}
        viewBox="0 0 24 24"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            d="M8 2L16 2"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M6 4L6 4.01"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M18.01 4L18 4"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M4 6L4 6.01"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M20.01 6L20 6"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M2 8L2 16"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M22 8L22 16"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M4.01001 18L4.00001 18"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M20.01 18L20 18"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M6.01001 20L6.00001 20"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M18.01 20L18 20"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M8 22L16 22"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M15.01 10L15 10"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M14 16L9.5 16L9.5 10"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M11.5 8H13"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
          <path
            d="M8 12H11"
            stroke={color || "currentColor"}
            strokeWidth="2"
            strokeLinecap="square"
            fill="none"
          />
        </g>
      </motion.svg>
    );
  },
  trashXmark({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <path
            opacity="0.3"
            d="M13.605 4.75L13.099 14.35C13.043 15.4201 12.165 16.25 11.102 16.25H6.89704C5.83304 16.25 4.95604 15.42 4.90004 14.35L4.39404 4.75"
            fill={color || "currentColor"}
            data-stroke="none"
            stroke="none"
          />
          <path d="M13.8557 4.75L13.35 14.35C13.294 15.4201 12.416 16.25 11.353 16.25H6.64796C5.58396 16.25 4.70696 15.42 4.65096 14.35L4.14526 4.75" />
          <path d="M7.23206 8.72998L10.7681 12.27" />
          <path d="M10.7681 8.72998L7.23206 12.27" />
          <path d="M2.75 4.75H15.25" />
          <path d="M6.75 4.75V2.75C6.75 2.2 7.198 1.75 7.75 1.75H10.25C10.802 1.75 11.25 2.2 11.25 2.75V4.75" />
        </g>
      </motion.svg>
    );
  },
  clipboardLines({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <path d="M6.25 3.75H5.25C4.42157 3.75 3.75 4.42157 3.75 5.25V14.25C3.75 15.0784 4.42157 15.75 5.25 15.75H12.75C13.5784 15.75 14.25 15.0784 14.25 14.25V5.25C14.25 4.42157 13.5784 3.75 12.75 3.75H11.75" />
          <path d="M6.75 2.25H11.25C11.5261 2.25 11.75 2.47386 11.75 2.75V4.25C11.75 4.52614 11.5261 4.75 11.25 4.75H6.75C6.47386 4.75 6.25 4.52614 6.25 4.25V2.75C6.25 2.47386 6.47386 2.25 6.75 2.25Z" />
          <path d="M6.5 8H11.5" />
          <path d="M6.5 10.5H11.5" />
          <path d="M6.5 13H9.75" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjx0aXRsZT5taW51czwvdGl0bGU+PGcgZmlsbD0iIzIxMjEyMSI+PHBhdGggZD0iTTE0Ljc1MDEgOS43NUgzLjI1MDEyQzIuODM2MDIgOS43NSAyLjUwMDEyIDkuNDE0MSAyLjUwMDEyIDlDMi41MDAxMiA4LjU4NTkgMi44MzYwMiA4LjI1IDMuMjUwMTIgOC4yNUgxNC43NTAxQzE1LjE2NDIgOC4yNSAxNS41MDAxIDguNTg1OSAxNS41MDAxIDlDMTUuNTAwMSA5LjQxNDEgMTUuMTY0MiA5Ljc1IDE0Ljc1MDEgOS43NVoiPjwvcGF0aD48L2c+PC9zdmc+)
   * @returns
   */
  minus({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="3.25" y1="9" x2="14.75" y2="9" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjx0aXRsZT5jaGVjazwvdGl0bGU+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlPSIjMjEyMTIxIj48cGF0aCBkPSJNMi43NSA5LjI1TDYuNzUgMTQuMjVMMTUuMjUgMy43NSI+PC9wYXRoPjwvZz48L3N2Zz4=)
   * @returns
   */
  check({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <path d="M2.75 9.25L6.75 14.25L15.25 3.75" />
        </g>
      </motion.svg>
    );
  },
  arrowRotateAnticlockwise({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            opacity="0.4"
            d="M9.00001 17C6.34701 17 3.87301 15.689 2.38001 13.492C2.14701 13.15 2.236 12.683 2.579 12.45C2.921 12.218 3.38801 12.305 3.62101 12.649C4.83401 14.434 6.84601 15.5 9.00101 15.5C12.585 15.5 15.501 12.584 15.501 9C15.501 5.416 12.585 2.5 9.00101 2.5C6.41601 2.5 4.07701 4.03099 3.04201 6.39999C2.87501 6.77899 2.43401 6.953 2.05401 6.787C1.67401 6.621 1.50101 6.179 1.66701 5.799C2.94001 2.884 5.81901 1 9.00001 1C13.411 1 17 4.589 17 9C17 13.411 13.411 17 9.00001 17Z"
          />
          <path d="M2.287 7C1.918 7 1.597 6.72799 1.545 6.35299L1.137 3.408C1.08 2.997 1.36599 2.61899 1.77699 2.56199C2.18699 2.50199 2.566 2.79099 2.623 3.20199L2.928 5.40401L5.129 5.099C5.536 5.045 5.91801 5.329 5.97501 5.74C6.03201 6.15 5.745 6.529 5.334 6.586L2.39 6.99299C2.355 6.99699 2.321 7 2.286 7H2.287Z" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjx0aXRsZT5tZWRpYS1zdG9wPC90aXRsZT48ZyBmaWxsPSIjMjEyMTIxIj48cmVjdCB4PSIyLjc1IiB5PSIyLjc1IiB3aWR0aD0iMTIuNSIgaGVpZ2h0PSIxMi41IiByeD0iMiIgcnk9IjIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzIxMjEyMSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBzdHJva2Utd2lkdGg9IjEuNSI+PC9yZWN0PjwvZz48L3N2Zz4=)
   * @returns
   */
  square({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <rect x="2.75" y="2.75" width="12.5" height="12.5" rx="2" ry="2" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4IiA+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0id2hpdGUiLz48ZyBmaWxsPSJub25lIiBzdHJva2VMaW5lY2FwPSJyb3VuZCIgc3Ryb2tlTGluZWpvaW49InJvdW5kIiBzdHJva2VXaWR0aD0iMS41IiBzdHJva2U9IiMyMTIxMjEiPjxyZWN0IHg9IjIuNzUiIHk9IjQuNzUiIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgcng9IjIiIHJ5PSIyIiAvPjxwYXRoIGQ9Ik0xNS4yNSAxMS4yNXYtNWE0IDQgMCAwIDAtNC00aC01IiBzdHJva2VMaW5lY2FwPSJyb3VuZCIgc3Ryb2tlTGluZWpvaW49InJvdW5kIiBzdHJva2VXaWR0aD0iMS41Ii8+PC9nPjwvc3ZnPg==)
   * @returns
   */
  stacksquare({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <rect x="2.75" y="4.75" width="10" height="10" rx="2" ry="2" />
          <path
            d="M15.25 11.25v-5a4 4 0 0 0-4-4h-5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
        </g>
      </motion.svg>
    );
  },
  wifi({ size, color, className, pathMotion, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <motion.path
            d="M9 15C10.1046 15 11 14.1046 11 13C11 11.8954 10.1046 11 9 11C7.89543 11 7 11.8954 7 13C7 14.1046 7.89543 15 9 15Z"
            fillOpacity="0.4"
            {...pathMotion}
          />
          <motion.path
            d="M8.99999 7C7.33099 7 5.76099 7.65 4.58099 8.831C4.28799 9.124 4.28799 9.599 4.58099 9.892C4.87399 10.185 5.34899 10.185 5.64199 9.892C6.53899 8.995 7.73199 8.501 8.99999 8.501C10.268 8.501 11.461 8.995 12.358 9.892C12.504 10.038 12.696 10.112 12.888 10.112C13.08 10.112 13.272 10.039 13.418 9.892C13.711 9.599 13.711 9.124 13.418 8.831C12.238 7.65 10.668 7 8.99899 7H8.99999Z"
            {...pathMotion}
          />
          <motion.path
            d="M16.248 6.002C14.312 4.066 11.738 3 9.00001 3C6.26201 3 3.68801 4.066 1.75201 6.002C1.45901 6.295 1.45901 6.77 1.75201 7.063C2.04501 7.356 2.52001 7.356 2.81301 7.063C4.46501 5.41 6.66401 4.5 9.00101 4.5C11.338 4.5 13.536 5.41 15.189 7.063C15.335 7.209 15.527 7.283 15.719 7.283C15.911 7.283 16.103 7.21 16.249 7.063C16.542 6.77 16.542 6.295 16.249 6.002H16.248Z"
            fillOpacity="0.4"
            {...pathMotion}
          />
        </g>
      </motion.svg>
    );
  },
  wifiOff({ size, color, className, pathMotion, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <motion.path
            d="M13.8081 4.19189C12.3452 3.41306 10.7044 3 9.00001 3C6.26201 3 3.68801 4.066 1.75201 6.002C1.45901 6.295 1.45901 6.77 1.75201 7.063C2.04501 7.356 2.52001 7.356 2.81301 7.063C4.46501 5.41 6.66401 4.5 9.00101 4.5C10.2963 4.5 11.549 4.77956 12.6897 5.31025L13.8081 4.19189Z"
            fillOpacity="0.4"
            {...pathMotion}
          />
          <motion.path
            d="M10.7521 7.24793C10.1897 7.0845 9.60076 7 8.99899 7H8.99999C7.33099 7 5.76099 7.65 4.58099 8.831C4.28799 9.124 4.28799 9.599 4.58099 9.892C4.87399 10.185 5.34899 10.185 5.64199 9.892C6.53899 8.995 7.73199 8.501 8.99999 8.501C9.15987 8.501 9.31856 8.50885 9.47561 8.52438L10.7521 7.24793Z"
            {...pathMotion}
          />
          <motion.path
            d="M7.23692 13.945C7.57424 14.573 8.23726 15 9 15C10.1046 15 11 14.1046 11 13C11 12.2372 10.573 11.5742 9.94505 11.2369L7.23692 13.945Z"
            fillOpacity="0.4"
            {...pathMotion}
          />
          <motion.path
            d="M14.6313 6.55063C14.8233 6.7125 15.0094 6.88335 15.189 7.06299C15.335 7.20899 15.527 7.28299 15.719 7.28299C15.911 7.28299 16.103 7.20999 16.249 7.06299C16.542 6.76999 16.542 6.29499 16.249 6.00199H16.248C16.0689 5.8229 15.8844 5.65126 15.6947 5.48721L14.6313 6.55063Z"
            fillOpacity="0.4"
            {...pathMotion}
          />
          <motion.path
            d="M11.782 9.39997C11.9848 9.54715 12.1774 9.71141 12.358 9.892C12.504 10.038 12.696 10.112 12.888 10.112C13.08 10.112 13.272 10.039 13.418 9.892C13.711 9.599 13.711 9.124 13.418 8.831C13.2384 8.65122 13.0497 8.48374 12.853 8.32898L11.782 9.39997Z"
            {...pathMotion}
          />
          <motion.path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M16.5303 1.46967C16.8232 1.76256 16.8232 2.23744 16.5303 2.53033L2.53033 16.5303C2.23744 16.8232 1.76256 16.8232 1.46967 16.5303C1.17678 16.2374 1.17678 15.7626 1.46967 15.4697L15.4697 1.46967C15.7626 1.17678 16.2374 1.17678 16.5303 1.46967Z"
            {...pathMotion}
          />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjx0aXRsZT54bWFyazwvdGl0bGU+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBzdHJva2Utd2lkdGg9IjEuNSIgc3Ryb2tlPSIjMjEyMTIxIj48cGF0aCBkPSJNMTQgNEw0IDE0Ij48L3BhdGg+PHBhdGggZD0iTTQgNEwxNCAxNCI+PC9wYXRoPjwvZz48L3N2Zz4=)
   * @returns
   */
  xmark({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="14" y1="4" x2="4" y2="14" />
          <line x1="4" y1="4" x2="14" y2="14" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjx0aXRsZT5waW4tdGFjay0yPC90aXRsZT48ZyBmaWxsPSJub25lIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2U9IiMyMTIxMjEiPjxwYXRoIGQ9Ik0xMC4zNzEgMTUuNTUzQzEwLjgwMyAxNC45OTYgMTEuMzkxIDE0LjA4MyAxMS43MTkgMTIuODM1QzExLjg4OCAxMi4xOTMgMTEuOTQ5IDExLjYxMSAxMS45NjIgMTEuMTM0TDE0Ljk2NyA4LjEyOUMxNS43NDggNy4zNDggMTUuNzQ4IDYuMDgyIDE0Ljk2NyA1LjMwMUwxMi42OTkgMy4wMzNDMTEuOTE4IDIuMjUyIDEwLjY1MiAyLjI1MiA5Ljg3MTAxIDMuMDMzTDYuODY2MDEgNi4wMzhDNi4zODgwMSA2LjA1MSA1LjgwNzAxIDYuMTEyIDUuMTY1MDEgNi4yODFDMy45MTcwMSA2LjYwOSAzLjAwNDAxIDcuMTk3IDIuNDQ3MDEgNy42MjlMMTAuMzcyIDE1LjU1NEwxMC4zNzEgMTUuNTUzWiIgZmlsbD0iIzIxMjEyMSIgZmlsbC1vcGFjaXR5PSIwLjMiIGRhdGEtc3Ryb2tlPSJub25lIiBzdHJva2U9Im5vbmUiPjwvcGF0aD48cGF0aCBkPSJNMy4wODA5OSAxNC45MTlMNi40MDg5OSAxMS41OTEiPjwvcGF0aD48cGF0aCBkPSJNMTAuMzcxIDE1LjU1M0MxMC44MDMgMTQuOTk2IDExLjM5MSAxNC4wODMgMTEuNzE5IDEyLjgzNUMxMS44ODggMTIuMTkzIDExLjk0OSAxMS42MTEgMTEuOTYyIDExLjEzNEwxNC45NjcgOC4xMjlDMTUuNzQ4IDcuMzQ4IDE1Ljc0OCA2LjA4MiAxNC45NjcgNS4zMDFMMTIuNjk5IDMuMDMzQzExLjkxOCAyLjI1MiAxMC42NTIgMi4yNTIgOS44NzEwMSAzLjAzM0w2Ljg2NjAxIDYuMDM4QzYuMzg4MDEgNi4wNTEgNS44MDcwMSA2LjExMiA1LjE2NTAxIDYuMjgxQzMuOTE3MDEgNi42MDkgMy4wMDQwMSA3LjE5NyAyLjQ0NzAxIDcuNjI5TDEwLjM3MiAxNS41NTRMMTAuMzcxIDE1LjU1M1oiPjwvcGF0aD48L2c+PC9zdmc+)
   * @returns
   */
  pin({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <path
            d="M10.371 15.553C10.803 14.996 11.391 14.083 11.719 12.835C11.888 12.193 11.949 11.611 11.962 11.134L14.967 8.129C15.748 7.348 15.748 6.082 14.967 5.301L12.699 3.033C11.918 2.252 10.652 2.252 9.87101 3.033L6.86601 6.038C6.38801 6.051 5.80701 6.112 5.16501 6.281C3.91701 6.609 3.00401 7.197 2.44701 7.629L10.372 15.554L10.371 15.553Z"
            fill={color || "currentColor"}
            fillOpacity="0.3"
            data-stroke="none"
            stroke="none"
          />
          <path d="M3.08099 14.919L6.40899 11.591" />
          <path d="M10.371 15.553C10.803 14.996 11.391 14.083 11.719 12.835C11.888 12.193 11.949 11.611 11.962 11.134L14.967 8.129C15.748 7.348 15.748 6.082 14.967 5.301L12.699 3.033C11.918 2.252 10.652 2.252 9.87101 3.033L6.86601 6.038C6.38801 6.051 5.80701 6.112 5.16501 6.281C3.91701 6.609 3.00401 7.197 2.44701 7.629L10.372 15.554L10.371 15.553Z" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjx0aXRsZT5sYW5ndWFnZTwvdGl0bGU+PGcgZmlsbD0iIzIxMjEyMSI+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik03IDIuMjVDNyAxLjgzNTc5IDYuNjY0MjEgMS41IDYuMjUgMS41QzUuODM1NzkgMS41IDUuNSAxLjgzNTc5IDUuNSAyLjI1VjMuNUgyLjI1QzEuODM1NzkgMy41IDEuNSAzLjgzNTc5IDEuNSA0LjI1QzEuNSA0LjY2NDIxIDEuODM1NzkgNSAyLjI1IDVIMy41NjM0N0MzLjc0Njc2IDYuMzAzMzEgNC4yOTgxOCA3LjUwMTcgNS4xMjEyIDguNDczMzZDNC45OTQxIDguNTU2IDQuODY2MjQgOC42MzIwNCA0LjczODc4IDguNzAyMDlDNC4wODk3NSA5LjA1ODc3IDMuNDQ2MTYgOS4yNjA3MSAyLjk2MjAyIDkuMzcyODVDMi43MjEyMSA5LjQyODYyIDIuNTIzMzkgOS40NjEzNyAyLjM4ODg3IDkuNDc5OTNDMi4yOTQ0MSA5LjQ5Mjk3IDIuMjQ0MzIgOS40OTgwNSAyLjE5ODY0IDkuNTAxNzVDMS43ODU5NyA5LjUzMDA2IDEuNDc0MDMgOS44ODcyMyAxLjUwMTY3IDEwLjMwMDFDMS41MjkzNSAxMC43MTM0IDEuODg2ODIgMTEuMDI2IDIuMzAwMTEgMTAuOTk4M0wyLjMwMTgyIDEwLjk5ODJDMi4zODA0NCAxMC45OTI3IDIuNDU3MzcgMTAuOTg0NyAyLjU5Mzk0IDEwLjk2NTlDMi43NjcyMyAxMC45NDE5IDMuMDEwMDMgMTAuOTAxNCAzLjMwMDQ4IDEwLjgzNDJDMy44Nzg4MyAxMC43MDAyIDQuNjYwMjUgMTAuNDU2OCA1LjQ2MTIyIDEwLjAxNjZDNS43MjAyOSA5Ljg3NDI3IDUuOTgwODYgOS43MTEzOCA2LjIzNjc5IDkuNTI1NTZDNi43NzIxNyA5LjkyNzY0IDcuMzcxMDMgMTAuMjU0NiA4LjAxOTYzIDEwLjQ4OUM4LjQwOTE3IDEwLjYyOTkgOC44MzkxMiAxMC40MjgyIDguOTc5OTQgMTAuMDM4N0M5LjEyMDc2IDkuNjQ5MTYgOC45MTkxMyA5LjIxOTIyIDguNTI5NTkgOS4wNzg0QzguMTE0MzkgOC45MjgzIDcuNzI1MjkgOC43Mjk2NyA3LjM2ODE5IDguNDg5OTZDOC4xMDU5NyA3LjYzNjI1IDguNjk0MTIgNi41MDA2IDguOTIxMjMgNUgxMC4yNUMxMC42NjQyIDUgMTEgNC42NjQyMSAxMSA0LjI1QzExIDMuODM1NzkgMTAuNjY0MiAzLjUgMTAuMjUgMy41SDdWMi4yNVpNNy40MDAwNSA1SDYuMjVINS4wODI1NEM1LjI1MTE5IDUuOTI5OCA1LjY2MDk0IDYuNzg0MTcgNi4yNTIyNyA3LjQ4Nzg4QzYuNzc2NzMgNi44NzI1IDcuMjAxMTYgNi4wNjUyOCA3LjQwMDA1IDVaIiBmaWxsLW9wYWNpdHk9IjAuNCI+PC9wYXRoPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMTIuMjUgN0MxMS45Mzc0IDcgMTEuNjU3NSA3LjE5MzkzIDExLjU0NzcgNy40ODY2Nkw4LjU0Nzc0IDE1LjQ4NjdDOC40MDIzIDE1Ljg3NDUgOC41OTg4MSAxNi4zMDY4IDguOTg2NjUgMTYuNDUyMkM5LjM3NDQ5IDE2LjU5NzcgOS44MDY4IDE2LjQwMTIgOS45NTIyNCAxNi4wMTMzTDEwLjcwNzIgMTRMMTQuMjkyNyAxNEwxNS4wNDc3IDE2LjAxMzNDMTUuMTkzMiAxNi40MDEyIDE1LjYyNTUgMTYuNTk3NyAxNi4wMTMzIDE2LjQ1MjJDMTYuNDAxMiAxNi4zMDY4IDE2LjU5NzcgMTUuODc0NSAxNi40NTIyIDE1LjQ4NjdMMTMuNDUyMiA3LjQ4NjY2QzEzLjM0MjUgNy4xOTM5MyAxMy4wNjI2IDcgMTIuNzUgN0gxMi4yNVpNMTMuNzMwMiAxMi41TDEyLjUgOS4yMTkzM0wxMS4yNjk3IDEyLjVMMTMuNzMwMiAxMi41WiI+PC9wYXRoPjwvZz48L3N2Zz4=)
   * @returns
   */
  lang({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <path d="M2.25 4.25H10.25" /> <path d="M6.25 2.25V4.25" />
          <path d="M4.25 4.25C4.341 6.926 6.166 9.231 8.75 9.934" />
          <path d="M8.25 4.25C7.85 9.875 2.25 10.25 2.25 10.25" />
          <path d="M9.25 15.75L12.25 7.75H12.75L15.75 15.75" />
          <path d="M10.188 13.25H14.813" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preivew ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxsaW5lIHgxPSIxMy4yNSIgeTE9IjUuMjUiIHgyPSIxNi4yNSIgeTI9IjUuMjUiIC8+PGxpbmUgeDE9IjEuNzUiIHkxPSI1LjI1IiB4Mj0iOC43NSIgeTI9IjUuMjUiIC8+PGNpcmNsZSBjeD0iMTEiIGN5PSI1LjI1IiByPSIyLjI1IiAvPjxsaW5lIHgxPSI0Ljc1IiB5MT0iMTIuNzUiIHgyPSIxLjc1IiB5Mj0iMTIuNzUiIC8+PGxpbmUgeDE9IjE2LjI1IiB5MT0iMTIuNzUiIHgyPSI5LjI1IiB5Mj0iMTIuNzUiIC8+PGNpcmNsZSBjeD0iNyIgY3k9IjEyLjc1IiByPSIyLjI1IiAvPjwvZz48L3N2Zz4=)
   * @returns
   */
  sliders({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="13.25" y1="5.25" x2="16.25" y2="5.25" />
          <line x1="1.75" y1="5.25" x2="8.75" y2="5.25" />
          <circle cx="11" cy="5.25" r="2.25" />
          <line x1="4.75" y1="12.75" x2="1.75" y2="12.75" />
          <line x1="16.25" y1="12.75" x2="9.25" y2="12.75" />
          <circle cx="7" cy="12.75" r="2.25" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preivew ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxsaW5lIHgxPSIxNS4yNSIgeTE9IjkiIHgyPSIxNi4yNSIgeTI9IjkiIC8+PGxpbmUgeDE9IjEuNzUiIHkxPSI5IiB4Mj0iOSIgeTI9IjkiIC8+PGxpbmUgeDE9IjUiIHkxPSIzLjc1IiB4Mj0iMS43NSIgeTI9IjMuNzUiIC8+PGxpbmUgeDE9IjE2LjI1IiB5MT0iMy43NSIgeDI9IjExLjI1IiB5Mj0iMy43NSIgLz48bGluZSB4MT0iNSIgeTE9IjE0LjI1IiB4Mj0iMS43NSIgeTI9IjE0LjI1IiAvPjxsaW5lIHgxPSIxNi4yNSIgeTE9IjE0LjI1IiB4Mj0iMTEuMjUiIHkyPSIxNC4yNSIgLz48Y2lyY2xlIGN4PSIxMSIgY3k9IjkiIHI9IjEuNzUiIC8+PGNpcmNsZSBjeD0iNi43NSIgY3k9IjMuNzUiIHI9IjEuNzUiIC8+PGNpcmNsZSBjeD0iNi43NSIgY3k9IjE0LjI1IiByPSIxLjc1IiAvPjwvZz48L3N2Zz4=)
   * @returns
   */
  sliders2({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="15.25" y1="9" x2="16.25" y2="9" />
          <line x1="1.75" y1="9" x2="9" y2="9" />
          <line x1="5" y1="3.75" x2="1.75" y2="3.75" />
          <line x1="16.25" y1="3.75" x2="11.25" y2="3.75" />
          <line x1="5" y1="14.25" x2="1.75" y2="14.25" />
          <line x1="16.25" y1="14.25" x2="11.25" y2="14.25" />
          <circle cx="11" cy="9" r="1.75" />
          <circle cx="6.75" cy="3.75" r="1.75" />
          <circle cx="6.75" cy="14.25" r="1.75" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxsaW5lIHgxPSI1LjI1IiB5MT0iOSIgeDI9IjEyLjc1IiB5Mj0iOSIgLz48bGluZSB4MT0iMi43NSIgeTE9IjQuMjUiIHgyPSIxNS4yNSIgeTI9IjQuMjUiIC8+PGxpbmUgeDE9IjgiIHkxPSIxMy43NSIgeDI9IjEwIiB5Mj0iMTMuNzUiIC8+PC9nPjwvc3ZnPg==)
   * @returns
   */
  barsFilter({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="5.25" y1="9" x2="12.75" y2="9" />
          <line x1="2.75" y1="4.25" x2="15.25" y2="4.25" />
          <line x1="8" y1="13.75" x2="10" y2="13.75" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preivew ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxlbGxpcHNlIGN4PSI5IiBjeT0iOSIgcng9IjMiIHJ5PSI3LjI1IiAvPjxsaW5lIHgxPSIyLjEwNiIgeTE9IjYuNzUiIHgyPSIxNS44OTQiIHkyPSI2Ljc1IiAvPjxsaW5lIHgxPSIyLjI5IiB5MT0iMTEuNzUiIHgyPSIxNS43MSIgeTI9IjExLjc1IiAvPjxjaXJjbGUgY3g9IjkiIGN5PSI5IiByPSI3LjI1IiAvPjwvZz48L3N2Zz4=)
   * @returns
   */
  globe3({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <ellipse cx="9" cy="9" rx="3" ry="7.25" />
          <line x1="2.106" y1="6.75" x2="15.894" y2="6.75" />
          <line x1="2.29" y1="11.75" x2="15.71" y2="11.75" />
          <circle cx="9" cy="9" r="7.25" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxwYXRoIGQ9Ik0xNC4yNCwxMy44MjNjMS4xOTUtLjYyNywyLjAxLTEuODgsMi4wMS0zLjMyMywwLTEuNzM2LTEuMTg1LTMuMTgyLTIuNzg2LTMuNjA5LS4xODYtMi4zMTQtMi4xMDItNC4xNDEtNC40NjQtNC4xNDEtMi40ODUsMC00LjUsMi4wMTUtNC41LDQuNSwwLC4zNSwuMDQ5LC42ODYsLjEyNCwxLjAxMy0xLjU5NywuMDY3LTIuODc0LDEuMzc0LTIuODc0LDIuOTg3LDAsMS4zMDYsLjgzNSwyLjQxNywyLDIuODI5IiAvPjxwb2x5bGluZSBwb2ludHM9IjkuMjUgMTMuNzUgMTEuNzUgMTMuNzUgMTEuNzUgMTEuMjUiIC8+PHBhdGggZD0iTTExLDE2LjM4N2MtLjUwMSwuNTMxLTEuMjEyLC44NjMtMiwuODYzLTEuNTE5LDAtMi43NS0xLjIzMS0yLjc1LTIuNzVzMS4yMzEtMi43NSwyLjc1LTIuNzVjMS4xNjYsMCwyLjE2MiwuNzI2LDIuNTYzLDEuNzUiIC8+PC9nPjwvc3ZnPg==)
   * @returns
   */
  cloudRefresh({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <path d="M14.24,13.823c1.195-.627,2.01-1.88,2.01-3.323,0-1.736-1.185-3.182-2.786-3.609-.186-2.314-2.102-4.141-4.464-4.141-2.485,0-4.5,2.015-4.5,4.5,0,.35,.049,.686,.124,1.013-1.597,.067-2.874,1.374-2.874,2.987,0,1.306,.835,2.417,2,2.829" />
          <polyline points="9.25 13.75 11.75 13.75 11.75 11.25" />
          <path d="M11,16.387c-.501,.531-1.212,.863-2,.863-1.519,0-2.75-1.231-2.75-2.75s1.231-2.75,2.75-2.75c1.166,0,2.162,.726,2.563,1.75" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxsaW5lIHgxPSIxNS4yNSIgeTE9IjE1LjI1IiB4Mj0iMTEuMjg1IiB5Mj0iMTEuMjg1IiAvPjxjaXJjbGUgY3g9IjcuNzUiIGN5PSI3Ljc1IiByPSI1IiAvPjxwYXRoIGQ9Ik03Ljc1LDUuMjVjMS4zODEsMCwyLjUsMS4xMTksMi41LDIuNSIgLz48L2c+PC9zdmc+)
   * @returns
   */
  magnifier3({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="15.25" y1="15.25" x2="11.285" y2="11.285" />
          <circle cx="7.75" cy="7.75" r="5" />
          <path d="M7.75,5.25c1.381,0,2.5,1.119,2.5,2.5" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxsaW5lIHgxPSI1Ljc1IiB5MT0iOSIgeDI9IjE2LjI1IiB5Mj0iOSIgLz48bGluZSB4MT0iMS43NSIgeTE9IjkiIHgyPSIyLjc1IiB5Mj0iOSIgLz48bGluZSB4MT0iMTUuMjUiIHkxPSIzLjc1IiB4Mj0iMTYuMjUiIHkyPSIzLjc1IiAvPjxsaW5lIHgxPSIxLjc1IiB5MT0iMy43NSIgeDI9IjEyLjI1IiB5Mj0iMy43NSIgLz48bGluZSB4MT0iMTUuMjUiIHkxPSIxNC4yNSIgeDI9IjE2LjI1IiB5Mj0iMTQuMjUiIC8+PGxpbmUgeDE9IjEuNzUiIHkxPSIxNC4yNSIgeDI9IjEyLjI1IiB5Mj0iMTQuMjUiIC8+PC9nPjwvc3ZnPg==)
   * @returns
   */
  menuBars({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="5.75" y1="9" x2="16.25" y2="9" />
          <line x1="1.75" y1="9" x2="2.75" y2="9" />
          <line x1="15.25" y1="3.75" x2="16.25" y2="3.75" />
          <line x1="1.75" y1="3.75" x2="12.25" y2="3.75" />
          <line x1="15.25" y1="14.25" x2="16.25" y2="14.25" />
          <line x1="1.75" y1="14.25" x2="12.25" y2="14.25" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxsaW5lIHgxPSI5IiB5MT0iMi43NSIgeDI9IjkiIHkyPSIxNS4yNSIgLz48cmVjdCB4PSIyLjc1IiB5PSIyLjc1IiB3aWR0aD0iMTIuNSIgaGVpZ2h0PSIxMi41IiByeD0iMiIgcnk9IjIiIC8+PC9nPjwvc3ZnPg==)
   * @returns
   */
  tableCols2({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="9" y1="2.75" x2="9" y2="15.25" />
          <rect x="2.75" y="2.75" width="12.5" height="12.5" rx="2" ry="2" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxjaXJjbGUgY3g9IjUiIGN5PSI1IiByPSIyLjUiIC8+PGNpcmNsZSBjeD0iMTMiIGN5PSI1IiByPSIyLjUiIC8+PGNpcmNsZSBjeD0iNSIgY3k9IjEzIiByPSIyLjUiIC8+PGNpcmNsZSBjeD0iMTMiIGN5PSIxMyIgcj0iMi41IiAvPjwvZz48L3N2Zz4=)
   * @returns
   */
  gridCircle({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <circle cx="5" cy="5" r="2.5" />
          <circle cx="13" cy="5" r="2.5" />
          <circle cx="5" cy="13" r="2.5" />
          <circle cx="13" cy="13" r="2.5" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9Im5vbmUiIHN0cm9rZUxpbmVjYXA9InJvdW5kIiBzdHJva2VMaW5lam9pbj0icm91bmQiIHN0cm9rZVdpZHRoPSIxLjUiIHN0cm9rZT0iIzIxMjEyMSIgPjxsaW5lIHgxPSI5IiB5MT0iMTUuMjUiIHgyPSI5IiB5Mj0iMi43NSIgLz48cG9seWxpbmUgcG9pbnRzPSIxMy4yNSAxMSA5IDE1LjI1IDQuNzUgMTEiIC8+PC9nPjwvc3ZnPg==)
   * @returns
   */
  arrowDown({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="9" y1="15.25" x2="9" y2="2.75" />
          <polyline points="13.25 11 9 15.25 4.75 11" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![img](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9IiMyMTIxMjEiPjxwYXRoIGQ9Im05LDFjLTIuNDg5LDAtNC43Njk0LDEuMTQ3OS02LjI2MiwzLjAzMjdsLS4xMTQ5LS44MzA2Yy0uMDU3Ni0uNDEwMi0uNDQ0My0uNjk3OC0uODQ1Ny0uNjM5Ni0uNDExMS4wNTY2LS42OTczLjQzNTUtLjY0MDYuODQ1N2wuNDA4MiwyLjk0NDhjLjA1MjcuMzc1NS4zNzQuNjQ3Ljc0MjIuNjQ3LjAzNDIsMCwuMDY5My0uMDAyNC4xMDM1LS4wMDY4bDIuOTQ0My0uNDA3MmMuNDEwMi0uMDU3MS42OTczLS40MzU1LjY0MDYtLjg0NTdzLS40NDA0LS42ODk1LS44NDU3LS42NDA2bC0xLjQ1NzMuMjAxN2MxLjE5ODQtMS43MjgzLDMuMTYzLTIuODAxMyw1LjMyNzQtMi44MDEzLDMuNTg0LDAsNi41LDIuOTE2LDYuNSw2LjVzLTIuOTE2LDYuNS02LjUsNi41Yy0zLjE3OTcsMC01Ljg3NC0yLjI3MDUtNi40MDcyLTUuMzk4OS0uMDY5My0uNDA4Mi0uNDUzMS0uNjc5Ny0uODY1Mi0uNjEzMy0uNDA4Mi4wNjkzLS42ODI2LjQ1Ny0uNjEzMy44NjUyLjY1NjIsMy44NTE2LDMuOTcyNyw2LjY0Nyw3Ljg4NTcsNi42NDcsNC40MTExLDAsOC0zLjU4ODksOC04UzEzLjQxMTEsMSw5LDFaIiBvcGFjaXR5PSIuNCIgc3Ryb2tlLXdpZHRoPSIwIj48L3BhdGg+PHBhdGggZD0ibTcuOTUyMSwxMmMtLjIxMTksMC0uNDE0MS0uMDg5NC0uNTU2Ni0uMjQ3MWwtMS44MjcxLTIuMDIyOWMtLjI3NzMtLjMwNzYtLjI1MzktLjc4MTcuMDUzNy0xLjA1OTYuMzA3Ni0uMjc1OS43ODEyLS4yNTM0LDEuMDU5Ni4wNTM3bDEuMjMwNSwxLjM2MjMsMy4zNzMtNC4yOTkzYy4yNTM5LS4zMjUyLjcyNDYtLjM4NDMsMS4wNTI3LS4xMjcuMzI2Mi4yNTU0LjM4MjguNzI3MS4xMjcsMS4wNTI3bC0zLjkyMjksNWMtLjEzNjcuMTc0My0uMzQyOC4yNzg4LS41NjM1LjI4NjYtLjAwODguMDAwNS0uMDE3Ni4wMDA1LS4wMjY0LjAwMDVaIiBzdHJva2Utd2lkdGg9IjAiPjwvcGF0aD48L2c+PC9zdmc+)
   * @returns
   */
  arrowRotateAnticlockwiseCheck({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            d="m9,1c-2.489,0-4.7694,1.1479-6.262,3.0327l-.1149-.8306c-.0576-.4102-.4443-.6978-.8457-.6396-.4111.0566-.6973.4355-.6406.8457l.4082,2.9448c.0527.3755.374.647.7422.647.0342,0,.0693-.0024.1035-.0068l2.9443-.4072c.4102-.0571.6973-.4355.6406-.8457s-.4404-.6895-.8457-.6406l-1.4573.2017c1.1984-1.7283,3.163-2.8013,5.3274-2.8013,3.584,0,6.5,2.916,6.5,6.5s-2.916,6.5-6.5,6.5c-3.1797,0-5.874-2.2705-6.4072-5.3989-.0693-.4082-.4531-.6797-.8652-.6133-.4082.0693-.6826.457-.6133.8652.6562,3.8516,3.9727,6.647,7.8857,6.647,4.4111,0,8-3.5889,8-8S13.4111,1,9,1Z"
            fillOpacity="0.4"
            strokeWidth="0"
          />
          <path
            d="m7.9521,12c-.2119,0-.4141-.0894-.5566-.2471l-1.8271-2.0229c-.2773-.3076-.2539-.7817.0537-1.0596.3076-.2759.7812-.2534,1.0596.0537l1.2305,1.3623,3.373-4.2993c.2539-.3252.7246-.3843,1.0527-.127.3262.2554.3828.7271.127,1.0527l-3.9229,5c-.1367.1743-.3428.2788-.5635.2866-.0088.0005-.0176.0005-.0264.0005Z"
            strokeWidth="0"
          />
        </g>
      </motion.svg>
    );
  },

  autoDownload({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            d="m9,1c-2.489,0-4.7694,1.1479-6.262,3.0327l-.1149-.8306c-.0576-.4102-.4443-.6978-.8457-.6396-.4111.0566-.6973.4355-.6406.8457l.4082,2.9448c.0527.3755.374.647.7422.647.0342,0,.0693-.0024.1035-.0068l2.9443-.4072c.4102-.0571.6973-.4355.6406-.8457s-.4404-.6895-.8457-.6406l-1.4573.2017c1.1984-1.7283,3.163-2.8013,5.3274-2.8013,3.584,0,6.5,2.916,6.5,6.5s-2.916,6.5-6.5,6.5c-3.1797,0-5.874-2.2705-6.4072-5.3989-.0693-.4082-.4531-.6797-.8652-.6133-.4082.0693-.6826.457-.6133.8652.6562,3.8516,3.9727,6.647,7.8857,6.647,4.4111,0,8-3.5889,8-8S13.4111,1,9,1Z"
            fillOpacity="0.4"
            strokeWidth="0"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M15 5.00146C15 4.58725 14.6642 4.25146 14.25 4.25146C13.8358 4.25146 13.5 4.58725 13.5 5.00146V11.1908L12.5303 10.2211C12.2374 9.92824 11.7626 9.92824 11.4697 10.2211C11.1768 10.514 11.1768 10.9889 11.4697 11.2818L13.7197 13.5318C14.0126 13.8247 14.4874 13.8247 14.7803 13.5318L17.0303 11.2818C17.3232 10.9889 17.3232 10.514 17.0303 10.2211C16.7374 9.92824 16.2626 9.92824 15.9697 10.2211L15 11.1908V5.00146Z"
            transform="translate(-5.25 0)"
            strokeWidth="0"
          />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9IiMyMTIxMjEiPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNNC41IDEuMjVDNC41IDAuODM1Nzg2IDQuMTY0MjEgMC41IDMuNzUgMC41QzMuMzM1NzkgMC41IDMgMC44MzU3ODYgMyAxLjI1VjNIMS4yNUMwLjgzNTc4NiAzIDAuNSAzLjMzNTc5IDAuNSAzLjc1QzAuNSA0LjE2NDIxIDAuODM1Nzg2IDQuNSAxLjI1IDQuNUgzVjYuMjVDMyA2LjY2NDIxIDMuMzM1NzkgNyAzLjc1IDdDNC4xNjQyMSA3IDQuNSA2LjY2NDIxIDQuNSA2LjI1VjQuNUg2LjI1QzYuNjY0MjEgNC41IDcgNC4xNjQyMSA3IDMuNzVDNyAzLjMzNTc5IDYuNjY0MjEgMyA2LjI1IDNINC41VjEuMjVaIj48L3BhdGg+PHBhdGggZD0iTTUgOC4xMjExMVYxMS4zMTRDNC42MjMgMTEuMTIgNC4yMDIgMTEgMy43NSAxMUMyLjIzMyAxMSAxIDEyLjIzMyAxIDEzLjc1QzEgMTUuMjY3IDIuMjMzIDE2LjUgMy43NSAxNi41QzUuMjY3IDE2LjUgNi41IDE1LjI2NyA2LjUgMTMuNzVWNy4zODQ5OEwxNCA2LjEzNDk4VjkuODEzOThDMTMuNjIzIDkuNjE5OTggMTMuMjAyIDkuNDk5OTggMTIuNzUgOS40OTk5OEMxMS4yMzMgOS40OTk5OCAxMCAxMC43MzMgMTAgMTIuMjVDMTAgMTMuNzY3IDExLjIzMyAxNSAxMi43NSAxNUMxNC4yNjcgMTUgMTUuNSAxMy43NjcgMTUuNSAxMi4yNVYzLjE4MDk4QzE1LjUgMi42NjQ5OCAxNS4yNzQgMi4xNzg5OCAxNC44ODEgMS44NDU5OEMxNC40ODcgMS41MTI5OCAxMy45NzMgMS4zNzA5OCAxMy40NjIgMS40NTQ5OFYxLjQ1Mzk4TDguMDIwMzQgMi4zNjExOEM4LjMyMDgxIDIuNzQzNjUgOC41IDMuMjI1OSA4LjUgMy43NUM4LjUgNC45OTI2NCA3LjQ5MjY0IDYgNi4yNSA2SDZWNi4yNUM2IDcuMDMwMSA1LjYwMjk5IDcuNzE3NDggNSA4LjEyMTExWiIgZmlsbC1vcGFjaXR5PSIwLjQiPjwvcGF0aD48L2c+PC9zdmc+)
   * @returns
   */
  musicPlus({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M4.5 1.25C4.5 0.835786 4.16421 0.5 3.75 0.5C3.33579 0.5 3 0.835786 3 1.25V3H1.25C0.835786 3 0.5 3.33579 0.5 3.75C0.5 4.16421 0.835786 4.5 1.25 4.5H3V6.25C3 6.66421 3.33579 7 3.75 7C4.16421 7 4.5 6.66421 4.5 6.25V4.5H6.25C6.66421 4.5 7 4.16421 7 3.75C7 3.33579 6.66421 3 6.25 3H4.5V1.25Z"
          />
          <path
            d="M5 8.12111V11.314C4.623 11.12 4.202 11 3.75 11C2.233 11 1 12.233 1 13.75C1 15.267 2.233 16.5 3.75 16.5C5.267 16.5 6.5 15.267 6.5 13.75V7.38498L14 6.13498V9.81398C13.623 9.61998 13.202 9.49998 12.75 9.49998C11.233 9.49998 10 10.733 10 12.25C10 13.767 11.233 15 12.75 15C14.267 15 15.5 13.767 15.5 12.25V3.18098C15.5 2.66498 15.274 2.17898 14.881 1.84598C14.487 1.51298 13.973 1.37098 13.462 1.45498V1.45398L8.02034 2.36118C8.32081 2.74365 8.5 3.2259 8.5 3.75C8.5 4.99264 7.49264 6 6.25 6H6V6.25C6 7.0301 5.60299 7.71748 5 8.12111Z"
            fillOpacity="0.4"
          />
        </g>
      </motion.svg>
    );
  },
  waveformLines({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M1.25 7.5C1.66421 7.5 2 7.83579 2 8.25V9.75C2 10.1642 1.66421 10.5 1.25 10.5C0.835786 10.5 0.5 10.1642 0.5 9.75V8.25C0.5 7.83579 0.835786 7.5 1.25 7.5Z"
            fillOpacity="0.4"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M16.25 7.5C16.6642 7.5 17 7.83579 17 8.25V9.75C17 10.1642 16.6642 10.5 16.25 10.5C15.8358 10.5 15.5 10.1642 15.5 9.75V8.25C15.5 7.83579 15.8358 7.5 16.25 7.5Z"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M4.25 3C4.66421 3 5 3.33579 5 3.75V14.25C5 14.6642 4.66421 15 4.25 15C3.83579 15 3.5 14.6642 3.5 14.25V3.75C3.5 3.33579 3.83579 3 4.25 3Z"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M7.25 5C7.66421 5 8 5.33579 8 5.75V12.25C8 12.6642 7.66421 13 7.25 13C6.83579 13 6.5 12.6642 6.5 12.25V5.75C6.5 5.33579 6.83579 5 7.25 5Z"
            fillOpacity="0.4"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M10.25 2C10.6642 2 11 2.33579 11 2.75V15.25C11 15.6642 10.6642 16 10.25 16C9.83579 16 9.5 15.6642 9.5 15.25V2.75C9.5 2.33579 9.83579 2 10.25 2Z"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M13.25 5C13.6642 5 14 5.33579 14 5.75V12.25C14 12.6642 13.6642 13 13.25 13C12.8358 13 12.5 12.6642 12.5 12.25V5.75C12.5 5.33579 12.8358 5 13.25 5Z"
            fillOpacity="0.4"
          />
        </g>
      </motion.svg>
    );
  },
  mediaPause({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M2 3.75C2 2.78334 2.78393 2 3.75 2H5.25C6.21607 2 7 2.78334 7 3.75V14.25C7 15.2167 6.21607 16 5.25 16H3.75C2.78393 16 2 15.2167 2 14.25V3.75Z"
            fillOpacity="0.4"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M11 3.75C11 2.78334 11.7839 2 12.75 2H14.25C15.2161 2 16 2.78334 16 3.75V14.25C16 15.2167 15.2161 16 14.25 16H12.75C11.7839 16 11 15.2167 11 14.25V3.75Z"
          />
        </g>
      </motion.svg>
    );
  },
  mediaPlay({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            d="M15.1 7.478L5.608 2.222C5.055 1.916 4.402 1.925 3.859 2.245C3.321 2.562 3 3.122 3 3.744V14.256C3 14.878 3.321 15.438 3.859 15.755C4.138 15.919 4.445 16.002 4.754 16.002C5.047 16.002 5.34 15.927 5.608 15.779L15.099 10.523C15.655 10.216 16 9.632 16 9.001C16 8.37 15.655 7.785 15.1 7.478Z"
            fillOpacity="0.4"
          />
        </g>
      </motion.svg>
    );
  },
  suitHearts({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <path
            d="M9.00003 16.25C9.00003 13.575 13.476 9.01699 14.515 7.59599C15.554 6.17499 15.613 4.58999 14.245 3.40099C12.716 2.07199 10.157 2.83999 9.00003 5.11799C7.84303 2.83899 5.28503 2.07199 3.75503 3.40099C2.38703 4.58999 2.44503 6.17499 3.48503 7.59599C4.52503 9.01699 9.00003 13.574 9.00003 16.25Z"
            fill={color || "currentColor"}
            fillOpacity="0.3"
            data-stroke="none"
            stroke="none"
          />
          <path d="M9.00003 16.25C9.00003 13.575 13.476 9.01699 14.515 7.59599C15.554 6.17499 15.613 4.58999 14.245 3.40099C12.716 2.07199 10.157 2.83999 9.00003 5.11799C7.84303 2.83899 5.28503 2.07199 3.75503 3.40099C2.38703 4.58999 2.44503 6.17499 3.48503 7.59599C4.52503 9.01699 9.00003 13.574 9.00003 16.25Z" />
        </g>
      </motion.svg>
    );
  },
  brush2({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 18}
        height={size || 18}
        viewBox="0 0 18 18"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <path
            d="m3.5833,9.75l-.6753,4.8623c-.0835.6013.3835,1.1377.9905,1.1377h10.203c.607,0,1.074-.5364.9905-1.1377l-.6753-4.8623H3.5833Z"
            fill={color || "currentColor"}
            opacity=".3"
            strokeWidth="0"
          />
          <path d="m11,12.75l.25,3" />
          <path d="m7,12.75l-.25,3" />
          <path d="m10.5,6.25l.2795-2.6556c.1071-1.0175-.6014-2.0011-1.6208-2.0877-1.1436-.0972-2.0666.8671-1.9492,1.9821l.2906,2.7612-2.009.287c-.8828.1261-1.5755.8215-1.6981,1.7048l-.8848,6.3707c-.0835.6012.3835,1.1376.9905,1.1376h10.203c.607,0,1.074-.5364.9905-1.1376l-.8848-6.3707c-.1227-.8833-.8153-1.5786-1.6981-1.7048l-2.009-.287Z" />
          <line x1="14.25" y1="9.75" x2="3.75" y2="9.75" />
        </g>
      </motion.svg>
    );
  },
  xmarksm({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 12}
        height={size || 12}
        viewBox="0 0 12 12"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            d="m2.25,10.5c-.192,0-.384-.073-.53-.22-.293-.293-.293-.768,0-1.061L9.22,1.72c.293-.293.768-.293,1.061,0s.293.768,0,1.061l-7.5,7.5c-.146.146-.338.22-.53.22Z"
            strokeWidth="0"
          />
          <path
            d="m9.75,10.5c-.192,0-.384-.073-.53-.22L1.72,2.78c-.293-.293-.293-.768,0-1.061s.768-.293,1.061,0l7.5,7.5c.293.293.293.768,0,1.061-.146.146-.338.22-.53.22Z"
            strokeWidth="0"
          />
        </g>
      </motion.svg>
    );
  },
  minussm({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 12}
        height={size || 12}
        viewBox="0 0 12 12"
        className={className}
        {...props}
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke={color || "currentColor"}
        >
          <line x1="10.75" y1="6" x2="1.25" y2="6" />
        </g>
      </motion.svg>
    );
  },
  /**
   *
   * @preview ![](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ3aGl0ZSIvPjxnIGZpbGw9IiMyMTIxMjEiPjxwYXRoIGQ9Ik05LjU3LDMuNjE3Yy0uMTU2LS4zNzUtLjUxOS0uNjE3LS45MjQtLjYxN0g0Yy0uNTUyLDAtMSwuNDQ5LTEsMXY0LjY0NmMwLC40MDYsLjI0MiwuNzY5LC42MTgsLjkyNCwuMTI0LC4wNTEsLjI1NSwuMDc2LC4zODMsLjA3NiwuMjYxLDAsLjUxNS0uMTAyLC43MDYtLjI5M2w0LjY0Ny00LjY0N2MuMjg2LS4yODcsLjM3MS0uNzE1LC4yMTYtMS4wODlaIj48L3BhdGg+PHBhdGggZD0iTTE0LjM4Miw4LjQyOWMtLjM3Ny0uMTU2LS44MDQtLjA2OC0xLjA4OSwuMjE3bC00LjY0Nyw0LjY0N2MtLjI4NiwuMjg3LS4zNzEsLjcxNS0uMjE2LDEuMDg5LC4xNTYsLjM3NSwuNTE5LC42MTcsLjkyNCwuNjE3aDQuNjQ2Yy41NTIsMCwxLS40NDksMS0xdi00LjY0NmMwLS40MDYtLjI0Mi0uNzY5LS42MTgtLjkyNFoiPjwvcGF0aD48L2c+PC9zdmc+)
   * @returns
   */
  caretMaximizeDiagonal2({ size, color, className, ...props }: IconProps) {
    return (
      <motion.svg
        xmlns="http://www.w3.org/2000/svg"
        width={size || 12}
        height={size || 12}
        viewBox="0 0 12 12"
        className={className}
        {...props}
      >
        <g fill={color || "currentColor"}>
          <path
            d="m10.383,4.93c-.375-.155-.803-.07-1.09.217l-4.146,4.146c-.287.287-.372.715-.217,1.09s.518.617.924.617h4.146c.551,0,1-.449,1-1v-4.146c0-.406-.242-.769-.617-.924Z"
            strokeWidth="0"
          />
          <path
            d="m6.146,1H2c-.551,0-1,.449-1,1v4.146c0,.406.242.769.617.924.125.052.255.077.384.077.26,0,.514-.102.706-.293L6.854,2.707c.287-.287.372-.715.217-1.09s-.518-.617-.924-.617Z"
            strokeWidth="0"
          />
        </g>
      </motion.svg>
    );
  },
};
