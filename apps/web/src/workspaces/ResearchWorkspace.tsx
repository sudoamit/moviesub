'use client';

import React from 'react';
import { NavTab } from '../components/Header';
import { LearningEngineDashboard } from '../components/LearningEngineDashboard';
import { AITradeLearningWidget } from '../components/AITradeLearningWidget';
import { ResearchStudio } from '../components/ResearchStudio';
import { BacktestDashboard } from '../components/BacktestDashboard';

interface ResearchWorkspaceProps {
  activeTab: NavTab;
  selectedSymbol: string;
}

export const ResearchWorkspace: React.FC<ResearchWorkspaceProps> = ({
  activeTab,
  selectedSymbol,
}) => {
  if (activeTab === 'learning') {
    return (
      <div className="space-y-6">
        <LearningEngineDashboard />
        <AITradeLearningWidget initialSymbol={selectedSymbol} />
      </div>
    );
  }

  if (activeTab === 'research') {
    return (
      <div className="space-y-6">
        <ResearchStudio />
      </div>
    );
  }

  if (activeTab === 'backtest') {
    return (
      <div className="space-y-5">
        <BacktestDashboard initialSymbol={selectedSymbol} />
      </div>
    );
  }

  return null;
};
