"use client";

import { useState } from "react";
import Link from "next/link";

export default function AdminLoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = "/admin";
      } else {
        setError("Incorrect username or password.");
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-lg"
      >
        <h1 className="mb-6 text-xl font-bold text-gray-900">Parkoff Admin</h1>

        <label className="mb-1 block text-sm font-medium text-gray-700">Username</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
          autoComplete="username"

          className="mb-4 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        <label className="mb-1 block text-sm font-medium text-gray-700">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          className="mb-4 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="h-11 w-full rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {loading ? "Checking…" : "Sign in"}
        </button>

        <Link href="/" className="mt-4 block text-center text-sm text-gray-400 hover:text-gray-600 transition-colors">
          ← Back to map
        </Link>
      </form>
    </div>
  );
}
