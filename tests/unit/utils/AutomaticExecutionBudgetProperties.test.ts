import {
  automaticExecutionBudgetProperties,
  automaticMemoryProperties,
} from '../../../src/utils/automaticMemory';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';
import { automaticAdminProperties, executeAutomaticAdmin } from '../../../src/utils/automaticAdmin';
import { AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS as bounds } from '../../../src/schemas/AutonomousPersonalExecutionBudgetV1.schema';

describe('native capture budget controls', () => {
  it('keeps existing limits as the static default and restricts controls to autonomous v3', () => {
    const mode = automaticExecutionBudgetProperties.find(
      (property) => property.name === 'automaticExecutionBudgetMode',
    )!;
    expect(mode.default).toBe('legacy');
    for (const property of automaticExecutionBudgetProperties) {
      expect(property.noDataExpression).toBe(true);
      expect(property.displayOptions?.show).toMatchObject({
        '@version': [3],
        automaticPreferenceInterpreter: ['autonomousPersonalV1'],
      });
      expect(automaticMemoryProperties).toContain(property);
    }
  });

  it.each([undefined, 'legacy', 'configuredV1'])(
    'previews only an explicitly selected configured policy (%s)',
    async (mode) => {
      const parameters = {
        automaticPreferenceInterpreter: 'autonomousPersonalV1',
        automaticMemoryProfile: 'conservative',
        ...(mode === undefined ? {} : { automaticExecutionBudgetMode: mode }),
      };
      const ctx = {
        getNode: () => ({ typeVersion: 3, parameters }),
        getNodeParameter: (name: string, _index: number, fallback: unknown) =>
          Object.prototype.hasOwnProperty.call(parameters, name)
            ? (parameters as Record<string, unknown>)[name]
            : fallback,
      } as unknown as IExecuteFunctions;
      const result = await executeAutomaticAdmin(
        ctx,
        {} as IGraphStorage,
        'previewAutomatic',
        0,
        '0'.repeat(64),
      );
      if (mode === 'configuredV1') {
        expect(result.executionBudget).toEqual({
          semantics: 'configured',
          version: 1,
          completion: { mode: 'inheritOverall' },
          syntax: { mode: 'inheritOverall' },
          finalizationReserve: { mode: 'automatic' },
        });
      } else expect(result).not.toHaveProperty('executionBudget');
    },
  );

  it('uses schema bounds and hides inactive numeric controls', () => {
    for (const name of ['automaticCompletionBudgetMs', 'automaticSyntaxBudgetMs']) {
      const property = automaticExecutionBudgetProperties.find((item) => item.name === name)!;
      expect(property.typeOptions).toMatchObject({
        minValue: bounds.stageLimitMs.min,
        maxValue: bounds.stageLimitMs.max,
      });
      expect(property.displayOptions?.show).toMatchObject({
        automaticExecutionBudgetMode: ['configuredV1'],
        [name.replace(/Ms$/, 'Mode')]: ['limited'],
      });
    }
    const reserve = automaticExecutionBudgetProperties.find(
      (item) => item.name === 'automaticFinalizationReserveMs',
    )!;
    expect(reserve.typeOptions).toMatchObject({
      minValue: bounds.fixedReserveMs.min,
      maxValue: bounds.fixedReserveMs.max,
    });
    expect(reserve.displayOptions?.show?.automaticFinalizationReserveMode).toEqual(['fixed']);
  });

  it('exposes the same controls on Admin without changing the resource boundary', () => {
    for (const control of automaticExecutionBudgetProperties) {
      const admin = automaticAdminProperties.find((property) => property.name === control.name)!;
      expect(admin).toBeDefined();
      expect(admin.default).toEqual(control.default);
      expect(admin.displayOptions?.show).toMatchObject({
        ...control.displayOptions?.show,
        resource: ['automaticMemory'],
      });
    }
  });
});
