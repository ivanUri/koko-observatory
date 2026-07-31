import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

export interface ObservatoryPlugin {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  component: ComponentType;
  badge?: string;
}
