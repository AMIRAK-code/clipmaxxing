import { Suspense } from "react";
import { AccountsView } from "@/components/accounts/accounts-view";

export const metadata = { title: "Accounts · KLIPZ" };

export default function AccountsPage() {
  return (
    <Suspense fallback={null}>
      <AccountsView />
    </Suspense>
  );
}
