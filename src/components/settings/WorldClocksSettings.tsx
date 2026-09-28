import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "../icons";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { useSettingsStore, type WorldClock } from "../../stores/settingsStore";
import { MAX_WORLD_CLOCKS, cityFromTimeZone } from "../../helpers/trayCalendarModel";

// World clocks shown across the top of the menu-bar calendar popover.
export default function WorldClocksSettings() {
  const { t } = useTranslation();
  const clocks = useSettingsStore((state) => state.worldClocks);
  const setClocks = useSettingsStore((state) => state.setWorldClocks);
  const timeZones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);

  const update = (index: number, patch: Partial<WorldClock>) =>
    setClocks(clocks.map((clock, i) => (i === index ? { ...clock, ...patch } : clock)));

  const changeTimeZone = (index: number, timeZone: string) => {
    const clock = clocks[index];
    // Keep a label the user typed; replace one that was just the old zone's city.
    const autoLabel = !clock.label || clock.label === cityFromTimeZone(clock.timeZone);
    update(index, { timeZone, ...(autoLabel ? { label: cityFromTimeZone(timeZone) } : {}) });
  };

  const addClock = () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setClocks([...clocks, { label: cityFromTimeZone(timeZone), timeZone }]);
  };

  return (
    <div>
      <SectionHeader
        title={t("settings.worldClocks.title")}
        description={t("settings.worldClocks.description")}
      />
      <SettingsPanel>
        {clocks.map((clock, index) => (
          <SettingsPanelRow key={index}>
            <div className="flex items-center gap-2">
              <Input
                dir="auto"
                value={clock.label}
                onChange={(event) => update(index, { label: event.target.value })}
                aria-label={t("settings.worldClocks.label")}
                placeholder={t("settings.worldClocks.label")}
                className="h-7 w-36 text-xs"
              />
              <Select
                value={clock.timeZone}
                onValueChange={(value) => changeTimeZone(index, value)}
              >
                <SelectTrigger
                  aria-label={t("settings.worldClocks.timeZone")}
                  className="h-7 flex-1 rounded-lg px-2.5 text-xs [&>svg]:h-3 [&>svg]:w-3"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {timeZones.map((zone) => (
                    <SelectItem key={zone} value={zone} className="text-xs">
                      {zone.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                onClick={() => setClocks(clocks.filter((_, i) => i !== index))}
                aria-label={t("settings.worldClocks.remove")}
                title={t("settings.worldClocks.remove")}
                className="rounded p-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
              >
                <X size={14} />
              </button>
            </div>
          </SettingsPanelRow>
        ))}
        {clocks.length < MAX_WORLD_CLOCKS && (
          <SettingsPanelRow>
            <button
              type="button"
              onClick={addClock}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus size={12} />
              {t("settings.worldClocks.add")}
            </button>
          </SettingsPanelRow>
        )}
      </SettingsPanel>
    </div>
  );
}
