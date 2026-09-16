'use client';

import React, { KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { NavGroup } from './PrimaryNavigation';

interface NavGroupButtonProps {
  groupId: NavGroup;
  label: string;
  hasDropdown: boolean;
  isActive: boolean;
  isOpen: boolean;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

export const NavGroupButton: React.FC<NavGroupButtonProps> = ({
  groupId,
  label,
  hasDropdown,
  isActive,
  isOpen,
  onClick,
  onKeyDown,
  buttonRef,
}) => {
  return (
    <button
      ref={buttonRef}
      type="button"
      id={`nav-group-${groupId}`}
      aria-expanded={hasDropdown ? isOpen : undefined}
      aria-haspopup={hasDropdown ? 'menu' : undefined}
      aria-controls={hasDropdown ? `dropdown-menu-${groupId}` : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-subtle ${
        isActive
          ? 'bg-surface-elevated text-cyan-400 border border-cyan-500/30 shadow-sm'
          : 'text-slate-300 hover:text-white hover:bg-surface-hover'
      }`}
    >
      <span>{label}</span>
      {hasDropdown && (
        <ChevronDown
          className={`w-3 h-3 text-slate-400 transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      )}
    </button>
  );
};
