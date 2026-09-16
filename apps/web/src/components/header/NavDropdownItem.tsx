'use client';

import React from 'react';
import { NavItemConfig, NavTab } from './PrimaryNavigation';

interface NavDropdownItemProps {
  item: NavItemConfig;
  isActive: boolean;
  isFocused: boolean;
  onSelect: (tab: NavTab) => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

export const NavDropdownItem: React.FC<NavDropdownItemProps> = ({
  item,
  isActive,
  isFocused,
  onSelect,
  buttonRef,
}) => {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      tabIndex={isFocused ? 0 : -1}
      onClick={() => onSelect(item.id)}
      className={`w-full text-left px-2.5 py-2 rounded-lg text-xs font-mono transition-colors flex items-center justify-between outline-none focus-visible:bg-surface-hover focus-visible:text-white ${
        isActive
          ? 'bg-cyan-500/20 text-cyan-300 font-bold'
          : 'text-slate-300 hover:bg-surface-hover hover:text-white'
      }`}
    >
      <div className="flex items-center gap-2">
        {item.icon}
        <span>{item.label}</span>
      </div>
      {item.badge && (
        <span className="text-[9px] px-1 py-0.5 rounded font-black bg-cyan-950 text-cyan-400 border border-cyan-800">
          {item.badge}
        </span>
      )}
    </button>
  );
};
