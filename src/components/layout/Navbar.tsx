import Link from "next/link";

export default function Navbar() {
  return (
    <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-[60px] max-w-5xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-bold tracking-tight text-indigo-600">
          Park Off
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-6 text-sm font-medium text-gray-600 sm:flex">
          <a href="#how-it-works" className="transition-colors hover:text-indigo-600">How it works</a>
        </nav>

        {/* Submit CTA — always visible */}
        <Link
          href="/submit"
          className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
        >
          Submit a sign
        </Link>
      </div>
    </header>
  );
}
