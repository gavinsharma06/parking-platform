import Navbar from "@/components/layout/Navbar";
import AdminDashboard from "./AdminDashboard";

export const metadata = {
  title: "Admin — Park Off",
};

export default function AdminPage() {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900">
      <Navbar />

      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-4xl">
          <div className="mb-8">
            <span className="inline-block rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-indigo-600">
              Admin
            </span>
            <h1 className="mt-3 text-2xl font-bold text-gray-900">
              Sign Submissions
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Review community-submitted parking signs. Approve to add to the
              live map, reject to discard.
            </p>
          </div>

          <AdminDashboard />
        </div>
      </main>
    </div>
  );
}
