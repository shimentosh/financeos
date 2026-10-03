import type { StorageConfigView } from "@financeos/core";
import { AdminPage } from "@/components/admin/admin-page";
import { StorageSettings } from "@/components/admin/storage-settings";
import { api } from "@/lib/api/server";

export const metadata = { title: "Storage · Admin" };

export default async function Page() {
  const view = await api<StorageConfigView>("/admin/storage");
  return (
    <AdminPage
      title="Storage"
      description="Where receipts, screenshots, statements and attachments are kept for the whole installation: this server's disk, Cloudflare R2 or any S3-compatible bucket."
    >
      <StorageSettings view={view} />
    </AdminPage>
  );
}
