import { ObservatoryApp } from "@/src/components/observatory-app";

export default async function PluginRoute({ params }: { params: Promise<{ plugin: string }> }) {
  const { plugin } = await params;
  return <ObservatoryApp initialPlugin={plugin} />;
}
