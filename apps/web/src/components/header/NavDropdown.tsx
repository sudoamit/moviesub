'use client';

import React, { KeyboardEvent } from 'react';
import { NavItemConfig, NavTab } from './PrimaryNavigation';
import { NavDropdownItem } from './NavDropdownItem';

interface NavDropdownProps {
  groupId: string;
  groupLabel: string;
  items: NavItemConfig[];
  activeTab: NavTab;
  focusedIndex: number;
  onSelectTab: (tab: NavTab) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
}

export const NavDropdown: React.FC<NavDropdownProps> = ({
  groupId,
  groupLabel,
  items,
  activeTab,
  focusedIndex,
  onSelectTab,
  onKeyDown,
  itemRefs,
}) => {
  return (
    <div
      id={`dropdown-menu-${groupId}`}
      role="menu"
      aria-labelledby={`nav-group-${groupId}`}
      onKeyDown={onKeyDown}
      className="absolute top-full left-0 mt-2 w-56 bg-surface-elevated border border-surface-border rounded-xl p-1.5 shadow-2xl z-50 animate-in fade-in slide-in-from-top-2 duration-150 focus:outline-none"
    >
      <div className="px-2 py-1 text-[10px] text-slate-400 uppercase tracking-wider font-semibold border-b border-surface-border mb-1">
        {groupLabel} Tools
      </div>
      {items.map((item, idx) => {
        const isItemActive = activeTab === item.id;
        return (
          <NavDropdownItem
            key={item.id}
            item={item}
            isActive={isItemActive}
            isFocused={focusedIndex === idx}
            onSelect={onSelectTab}
            buttonRef={(el) => {
              itemRefs.current[idx] = el;
            }}
          />
        );
      })}
    </div>
  );
};
