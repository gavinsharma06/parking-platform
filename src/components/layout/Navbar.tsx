"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

export default function Navbar() {
  const [adminUser, setAdminUser] = useState("");

  useEffect(() => {
    const match = document.cookie.match(/admin_user=([^;]+)/);
    if (match) setAdminUser(match[1]);
  }, []);

  return (
    <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-[60px] max-w-5xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-bold tracking-tight text-indigo-600">
          Park Off
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-6 text-sm font-medium text-gray-600 sm:flex">
          <a href="/#how-it-works" className="transition-colors hover:text-indigo-600">How it works</a>
          <Link
            href="/admin"
            className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-600 transition-colors hover:bg-indigo-100"
          >
            Admin
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          {adminUser && (
            <span className="hidden items-center gap-1.5 sm:flex">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-xs font-medium text-gray-500 capitalize">
                Admin · {adminUser}
              </span>
            </span>
          )}
          <Link
            href="/can-i-park"
            className="rounded-full bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700"
          >
            Can I Park Here?
          </Link>
          <Link
            href="/submit"
            className="hidden sm:block rounded-full border border-indigo-200 px-4 py-2 text-sm font-semibold text-indigo-600 hover:bg-indigo-50"
          >
            Submit a sign
          </Link>
        </div>
      </div>
    </header>
  );
}
