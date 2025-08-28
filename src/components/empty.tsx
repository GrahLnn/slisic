import { cn } from "@/lib/utils";

interface EmptyPageProps {
  symbol: React.ReactNode;
  explain: string;
  cta: string;
  onClick: () => void;
}

export function EmptyPage({ symbol, explain, cta, onClick }: EmptyPageProps) {
  return (
    <div className="flex justify-center items-center flex-col text-center gap-8 overflow-hidden flex-1">
      {symbol}
      <p className="text-sm font-medium text-[#171717] dark:text-[#D9D9D9] select-none">
        {explain}
      </p>
      <div className="h-4" />
      <div
        className={cn([
          "text-xs text-[#525252] dark:text-[#a3a3a3] hover:bg-[#f7f7f9] dark:hover:bg-[#373737] hover:dark:text-[#e5e5e5] py-1 px-2 rounded-md transition duration-300 cursor-pointer select-none",
          "hover:shadow-[var(--butty-shadow)] dark:hover:[box-shadow:0_0_30px_0_#8a8a8a,0_0_50px_30px_#262626] dark:hover:[mix-blend-mode:plus-lighter]",
        ])}
        onClick={onClick}
      >
        {cta}
      </div>
    </div>
  );
}
