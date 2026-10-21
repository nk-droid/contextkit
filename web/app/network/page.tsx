import type { Metadata } from "next";
import { ComponentNetwork } from "../components/ComponentNetwork";
import "./network.css";

export const metadata: Metadata = {
  title: "Component network · ContextKit",
  description:
    "See every component, store, and declaration in a repository and each way they are coupled.",
};

export default function NetworkPage() {
  return <ComponentNetwork />;
}
