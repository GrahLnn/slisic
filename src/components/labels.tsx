import { me } from "@/lib/matchable";
import { cn } from "@/lib/utils";
import { motionIcons } from "../assets/icons";

function Wrapper({
  children,
  withHover = false,
}: {
  children: React.ReactNode;
  withHover?: boolean;
}) {
  return (
    <div
      className={cn([
        "font-neuemontrealmono text-[38px] transition-colors duration-300 md:text-[56px]",
        withHover
          ? "text-[#F2F2F2] dark:text-[#242424] group-hover:text-[#E8E8E8] dark:group-hover:text-[#2E2E2E]"
          : "text-[#a3a3a3] dark:text-[#525252]",
      ])}
    >
      {children}
    </div>
  );
}

export const labels = {
  account: ({ withHover = false }: { withHover?: boolean }) => {
    const bg = me(withHover).match({
      true: () =>
        "rounded-[1px] h-1 bg-[#f2f2f2] group-hover:bg-[#E8E8E8] dark:bg-[#242424] dark:group-hover:bg-[#2E2E2E] transition-colors duration-300",
      false: () =>
        "rounded-[1px] h-1 bg-[#E8E8E8] dark:bg-[#2E2E2E] transition-colors duration-300",
    });
    return (
      <div
        className={cn([
          "w-14 h-12 md:w-20 md:h-14 border rounded-md py-2 px-4 flex flex-col items-center justify-center gap-2",
          withHover
            ? "border-black/5 group-hover:border-black/10 dark:borderWhite/5 dark:group-hover:borderWhite/10"
            : "border-black/10 dark:borderWhite/10",
        ])}
      >
        <div
          className={cn([
            "rounded-full h-2 w-2",
            withHover
              ? "bg-[#E5E5E5] group-hover:bg-[#E8E8E8] dark:bg-[#242424] dark:group-hover:bg-[#2E2E2E] transition-colors duration-300"
              : "bg-[#E8E8E8] dark:bg-[#2E2E2E]",
          ])}
        />
        <div className="w-full flex flex-col gap-1">
          <div className={cn([bg, "w-full"])} />
          <div className={cn([bg, "w-2/5"])} />
          <div className={cn([bg, "w-3/5"])} />
        </div>
      </div>
    );
  },
  code: ({ withHover = false }: { withHover?: boolean }) => (
    <Wrapper withHover={withHover}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="60"
        height="60"
        viewBox="0 0 18 18"
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke="currentColor"
        >
          <polyline points="2.75 14.25 8 9 2.75 3.75" />
          <line x1="9.5" y1="14.25" x2="15.25" y2="14.25" />
        </g>
      </svg>
    </Wrapper>
  ),
  bankcard: ({ withHover = false }: { withHover?: boolean }) => (
    <Wrapper withHover={withHover}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="60"
        height="60"
        viewBox="0 0 18 18"
        className="fill-current w-full h-full"
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke="currentColor"
        >
          <path d="M3.25,5.75V14.25c0,1.105,.895,2,2,2h7.5c1.105,0,2-.895,2-2V5.75" />
          <line x1="10.75" y1="16.25" x2="10.75" y2="5.75" />
          <line x1="6.25" y1="13.25" x2="6.25" y2="10.75" />
          <line x1="1.75" y1="2.75" x2="16.25" y2="2.75" strokeWidth="0.9" />
        </g>
      </svg>
    </Wrapper>
  ),
  prase: ({ withHover = false }: { withHover?: boolean }) => (
    <div
      className={cn([
        "flex h-8 w-9/12 items-center justify-center md:h-10 md:w-8/12 md:textLg",
        "rounded-full bg-[#f2f2f2] text-sm text-[#d6d6d6]",
        "transition-colors duration-300 group-hover:bg-[#E8E8E8] group-hover:text-[#C2C2C2]",
        "dark:bg-[#242424] dark:text-[#1A1A1A] dark:group-hover:bg-[#2E2E2E] dark:group-hover:text-[#121212]",
      ])}
      style={{ fontFamily: '"Maple Mono", monospace' }}
    >
      $&@%
    </div>
  ),
  note: ({ withHover = false }: { withHover?: boolean }) => (
    <Wrapper withHover={withHover}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="60"
        height="60"
        viewBox="0 0 18 18"
        className="fill-current w-full h-full"
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="0.9"
          stroke="currentColor"
        >
          <path
            d="M13.25 1.75H4.75C3.64543 1.75 2.75 2.64543 2.75 3.75V14.25C2.75 15.3546 3.64543 16.25 4.75 16.25H13.25C14.3546 16.25 15.25 15.3546 15.25 14.25V3.75C15.25 2.64543 14.3546 1.75 13.25 1.75Z"
            stroke="none"
          />
          <path d="M5.75 11.25H9" strokeWidth="1.5" />
          <path d="M5.75 8.25H12.25" strokeWidth="1.5" />
          <path d="M5.75 5.25H12.25" strokeWidth="1.5" />
          <path d="M13.25 1.75H4.75C3.64543 1.75 2.75 2.64543 2.75 3.75V14.25C2.75 15.3546 3.64543 16.25 4.75 16.25H13.25C14.3546 16.25 15.25 15.3546 15.25 14.25V3.75C15.25 2.64543 14.3546 1.75 13.25 1.75Z" />
        </g>
      </svg>
    </Wrapper>
  ),
  snip: ({ withHover = false }: { withHover?: boolean }) => (
    <Wrapper withHover={withHover}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="60"
        height="60"
        viewBox="0 0 18 18"
      >
        <g fill="currentColor">
          <path d="M9 13C9.414 13 9.75 12.664 9.75 12.25C9.75 11.836 9.414 11.5 9 11.5C8.586 11.5 8.25 11.836 8.25 12.25C8.25 12.664 8.586 13 9 13Z" />
          <path d="M11.75 13C12.164 13 12.5 12.664 12.5 12.25C12.5 11.836 12.164 11.5 11.75 11.5C11.336 11.5 11 11.836 11 12.25C11 12.664 11.336 13 11.75 13Z" />
          <path d="M6.25 13C6.664 13 7 12.664 7 12.25C7 11.836 6.664 11.5 6.25 11.5C5.836 11.5 5.5 11.836 5.5 12.25C5.5 12.664 5.836 13 6.25 13Z" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M5.25 3.5C4.55921 3.5 4 4.05921 4 4.75V7.375C4 8.00347 3.75561 8.5751 3.35673 9C3.75561 9.4249 4 9.99653 4 10.625V13.25C4 13.9408 4.55921 14.5 5.25 14.5H6.25C6.66421 14.5 7 14.8358 7 15.25C7 15.6642 6.66421 16 6.25 16H5.25C3.73079 16 2.5 14.7692 2.5 13.25V10.625C2.5 10.1422 2.10779 9.75 1.625 9.75C1.21079 9.75 0.875 9.41421 0.875 9C0.875 8.58579 1.21079 8.25 1.625 8.25C2.10779 8.25 2.5 7.85779 2.5 7.375V4.75C2.5 3.23079 3.73079 2 5.25 2H6.25C6.66421 2 7 2.33579 7 2.75C7 3.16421 6.66421 3.5 6.25 3.5H5.25Z"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M11 2.75C11 2.33579 11.3358 2 11.75 2H12.75C14.2692 2 15.5 3.23079 15.5 4.75V7.375C15.5 7.85779 15.8922 8.25 16.375 8.25C16.7892 8.25 17.125 8.58579 17.125 9C17.125 9.41421 16.7892 9.75 16.375 9.75C15.8922 9.75 15.5 10.1422 15.5 10.625V13.25C15.5 14.7692 14.2692 16 12.75 16H11.75C11.3358 16 11 15.6642 11 15.25C11 14.8358 11.3358 14.5 11.75 14.5H12.75C13.4408 14.5 14 13.9408 14 13.25V10.625C14 9.99653 14.2444 9.4249 14.6433 9C14.2444 8.5751 14 8.00347 14 7.375V4.75C14 4.05921 13.4408 3.5 12.75 3.5H11.75C11.3358 3.5 11 3.16421 11 2.75Z"
          />
        </g>
      </svg>
    </Wrapper>
  ),
  settings: ({ withHover = false }: { withHover?: boolean }) => (
    <Wrapper withHover={withHover}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="60"
        height="60"
        viewBox="0 0 18 18"
      >
        <g
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          stroke="currentColor"
        >
          <circle cx="9" cy="9" r="1.75" fill="currentColor" />
          <path d="m16.25,9.355v-.71c0-.51-.383-.938-.89-.994l-1.094-.122-.503-1.214.688-.859c.318-.398.287-.971-.074-1.332l-.502-.502c-.36-.36-.934-.392-1.332-.074l-.859.688-1.214-.503-.122-1.094c-.056-.506-.484-.89-.994-.89h-.71c-.51,0-.938.383-.994.89l-.122,1.094-1.214.503-.859-.687c-.398-.318-.971-.287-1.332.074l-.502.502c-.36.36-.392.934-.074,1.332l.688.859-.503,1.214-1.094.122c-.506.056-.89.484-.89.994v.71c0,.51.383.938.89.994l1.094.122.503,1.214-.687.859c-.318.398-.287.972.074,1.332l.502.502c.36.36.934.392,1.332.074l.859-.688,1.214.503.122,1.094c.056.506.484.89.994.89h.71c.51,0,.938-.383.994-.89l.122-1.094,1.214-.503.859.688c.398.318.971.287,1.332-.074l.502-.502c.36-.36.392-.934.074-1.332l-.687-.859.503-1.214,1.094-.122c.506-.056.89-.484.89-.994l-.002-.001Z" />
        </g>
      </svg>
    </Wrapper>
  ),
  prompt: ({ withHover = false }: { withHover?: boolean }) => (
    <Wrapper withHover={withHover}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="60"
        height="60"
        viewBox="0 0 18 18"
      >
        <g fill="currentColor">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8.6 2C8.29045 2 8.01271 2.19017 7.90076 2.47877L4.41579 11.4632C4.36203 11.5931 4.34607 11.7422 4.37005 11.8789C4.40794 12.0976 4.5371 12.2843 4.72911 12.3968C4.84654 12.4659 4.98871 12.5032 5.12617 12.5H12.3798L13.5518 15.5212C13.7016 15.9074 14.1361 16.099 14.5222 15.9492C14.9084 15.7994 15.1 15.3649 14.9502 14.9788L10.1012 2.47875C9.98929 2.19017 9.71154 2 9.402 2H8.6ZM11.7979 11L9.00101 3.79008L6.20437 11H11.7979Z"
          />
          <path d="M15.494 1.492L14.548 1.17699L14.232 0.229988C14.13 -0.0760116 13.623 -0.0760116 13.521 0.229988L13.205 1.17699L12.259 1.492C12.106 1.543 12.002 1.686 12.002 1.848C12.002 2.01 12.106 2.15299 12.259 2.20399L13.205 2.51899L13.521 3.466C13.572 3.619 13.715 3.72199 13.876 3.72199C14.037 3.72199 14.181 3.618 14.231 3.466L14.547 2.51899L15.493 2.20399C15.646 2.15299 15.75 2.01 15.75 1.848C15.75 1.686 15.646 1.543 15.493 1.492H15.494Z" />
          <path d="M4.659 13.526L3.396 13.105L2.975 11.842C2.838 11.434 2.163 11.434 2.026 11.842L1.605 13.105L0.342 13.526C0.138 13.594 0 13.785 0 14C0 14.215 0.138 14.406 0.342 14.474L1.605 14.895L2.026 16.158C2.094 16.362 2.286 16.5 2.501 16.5C2.716 16.5 2.907 16.362 2.976 16.158L3.397 14.895L4.66 14.474C4.864 14.406 5.002 14.215 5.002 14C5.002 13.785 4.863 13.594 4.659 13.526Z" />
          <path d="M2.75098 6C3.16518 6 3.50098 5.664 3.50098 5.25C3.50098 4.836 3.16518 4.5 2.75098 4.5C2.33678 4.5 2.00098 4.836 2.00098 5.25C2.00098 5.664 2.33678 6 2.75098 6Z" />
        </g>
      </svg>
    </Wrapper>
  ),
  phone: ({ withHover = false }: { withHover?: boolean }) => (
    <Wrapper withHover={withHover}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="60"
        height="60"
        viewBox="0 0 18 18"
      >
        <g fill="currentColor">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M5.59085 7.23286C5.91945 6.77317 6.44955 6.5 7.01501 6.5H9.0005H10.986C11.5523 6.5 12.081 6.77385 12.4091 7.23286L15.675 11.8041C15.8861 12.1006 16 12.4555 16 12.82L16 14.25C16 15.2162 15.2162 16 14.25 16H3.75C2.78379 16 2 15.2162 2 14.25L2 12.82C2 12.4569 2.11313 12.1002 2.32574 11.803L5.59085 7.23286Z"
            fillOpacity="0.4"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M6.5 11C6.5 9.61979 7.61979 8.5 9 8.5C10.3802 8.5 11.5 9.61979 11.5 11C11.5 12.3802 10.3802 13.5 9 13.5C7.61979 13.5 6.5 12.3802 6.5 11ZM9 10C8.44821 10 8 10.4482 8 11C8 11.5518 8.44821 12 9 12C9.55179 12 10 11.5518 10 11C10 10.4482 9.55179 10 9 10Z"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M7.25 4.75C7.66421 4.75 8 5.08579 8 5.5V6.25C8 6.66421 7.66421 7 7.25 7C6.83579 7 6.5 6.66421 6.5 6.25L6.5 5.5C6.5 5.08579 6.83579 4.75 7.25 4.75Z"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M10.75 4.75C11.1642 4.75 11.5 5.08579 11.5 5.5V6.25C11.5 6.66421 11.1642 7 10.75 7C10.3358 7 10 6.66421 10 6.25L10 5.5C10 5.08579 10.3358 4.75 10.75 4.75Z"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M2.27226 3.96605C3.59123 3.13166 5.92498 2 9 2C12.075 2 14.4088 3.13166 15.7277 3.96605C16.5223 4.46839 16.9929 5.33674 16.9999 6.26687C16.9909 7.22532 16.2106 8 15.25 8H14C13.4477 8 13 7.55228 13 7V4.88695C13 4.46932 12.7416 4.0917 12.3406 3.97507C11.3754 3.69433 10.194 3.5 9 3.5C7.80597 3.5 6.62463 3.69433 5.65941 3.97507C5.2584 4.0917 5 4.46932 5 4.88695V7C5 7.55228 4.55228 8 3.99999 8H2.75C1.78942 8 1.00914 7.22532 1.00008 6.26687C1.0071 5.33674 1.47775 4.46839 2.27226 3.96605ZM1.00008 6.26687L1 6.28799V6.25L1.00008 6.26687ZM16.9999 6.26687L17 6.28799V6.25L16.9999 6.26687Z"
          />
        </g>
      </svg>
    </Wrapper>
  ),
  musicPlus: ({
    withHover = false,
    layoutId,
  }: {
    withHover?: boolean;
    layoutId?: string;
  }) => (
    <Wrapper withHover={withHover}>
      <motionIcons.musicPlus size={60} layoutId={layoutId} />
    </Wrapper>
  ),
  musicPlay: ({
    withHover = false,
    layoutId,
  }: {
    withHover?: boolean;
    layoutId?: string;
  }) => (
    <Wrapper withHover={withHover}>
      <motionIcons.mediaPlay size={60} layoutId={layoutId} />
    </Wrapper>
  ),
  working: ({ withHover = false }: { withHover?: boolean }) => (
    <Wrapper withHover={withHover}>
      <motionIcons.live
        size={60}
        className="animate-spin [animation-duration:5s]"
      />
    </Wrapper>
  ),
};
