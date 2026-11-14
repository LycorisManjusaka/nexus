'use client';

// A sense seat's vessel picker (eyes / ears / video watcher), 2026-11-14.
//
// It is the Model tab's own FamilyModelPicker, narrowed by lib/sensorModels:
// only families the bridge can route to, and only models that can perceive
// that kind. Adding a vessel to the Model tab is therefore enough for it to
// appear here too — there is no second list to forget (式's "do not repeat
// yourself"). The saved value keeps the shape the bridges already read
// (`local:` prefix for local models), so no stored setting changes meaning.

import React from 'react';
import FamilyModelPicker from './FamilyModelPicker';
import { useT } from '@/lib/i18n';
import {
  type SenseKind, senseAccepts, senseFamilies, senseFamilyOf,
  senseStoredValue, sensePickerId, senseSeatDefault,
} from '@/lib/sensorModels';

export default function SenseModelPicker({
  kind, value, onChange, localModels, localModelsMeta, localModelsError, onRefreshLocal,
}: {
  kind: SenseKind;
  value: string;
  onChange: (v: string) => void;
  localModels: string[];
  localModelsMeta: Record<string, any>;
  localModelsError?: string | null;
  onRefreshLocal: () => void;
}) {
  const t = useT();
  const family = senseFamilyOf(kind, value);
  const families = senseFamilies(kind);
  return (
    <div className="rounded-xl border border-border p-3">
      <label className="text-xs font-medium text-muted-foreground block mb-1">{t('senses.seat.family')}</label>
      <select
        value={family}
        onChange={(e) => {
          const fam = e.target.value;
          if (fam === 'Local') {
            onRefreshLocal();
            const first = localModels.find((m) => senseAccepts(kind, 'Local', m, !!localModelsMeta[m]?.vision));
            onChange(first ? senseStoredValue('Local', first) : 'local:');
          } else {
            onChange(senseSeatDefault(kind, fam));
          }
        }}
        className="w-full mb-4 px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
      >
        {families.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
      <FamilyModelPicker
        compact
        hideBilling
        family={family}
        model={sensePickerId(value)}
        onModel={(m) => onChange(senseStoredValue(family, m))}
        keep={(id, localVision) => senseAccepts(kind, family, id, localVision)}
        // The eyes bridge always reaches Claude through the OAuth token, so
        // this seat has no billing choice; the switch is hidden above.
        authMode="oauth"
        onAuthMode={() => {}}
        localModels={localModels}
        localModelsMeta={localModelsMeta}
        localModelsError={localModelsError}
        onRefreshLocal={onRefreshLocal}
      />
    </div>
  );
}
