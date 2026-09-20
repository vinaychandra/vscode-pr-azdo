export interface IterationRange {
    iterationId: number;
    compareToIterationId: number;
    selectedIterationIds: number[];
}

export type IterationSelectionEntry =
    | { kind: 'iteration'; iterationId: number; latest: boolean }
    | { kind: 'base' };

export function iterationSelectionEntries(availableIterationIds: readonly number[]): IterationSelectionEntry[] {
    const available = [...new Set(availableIterationIds)].sort((first, second) => second - first);
    const latestIterationId = available[0];
    return [
        ...available.map(iterationId => ({
            kind: 'iteration' as const,
            iterationId,
            latest: iterationId === latestIterationId,
        })),
        { kind: 'base' as const },
    ];
}

export function resolveIterationRange(
    availableIterationIds: readonly number[],
    selectedIterationIds: readonly number[],
): IterationRange | undefined {
    const available = [...new Set(availableIterationIds)].sort((first, second) => first - second);
    if (available.length === 0) { return undefined; }
    const requested = [...new Set(selectedIterationIds)]
        .filter(iterationId => available.includes(iterationId))
        .sort((first, second) => first - second);
    const selected = requested.length > 0 ? requested : [available[available.length - 1]];

    const firstIndex = available.indexOf(selected[0]);
    const lastIndex = available.indexOf(selected[selected.length - 1]);
    if (firstIndex < 0 || lastIndex < firstIndex) { return undefined; }

    const contiguousSelection = available.slice(firstIndex, lastIndex + 1);

    return {
        iterationId: contiguousSelection[contiguousSelection.length - 1],
        compareToIterationId: firstIndex === 0 ? 0 : available[firstIndex - 1],
        selectedIterationIds: contiguousSelection,
    };
}

export function selectedIterationIds(
    availableIterationIds: readonly number[],
    iterationId: number,
    compareToIterationId: number,
): number[] {
    const available = [...new Set(availableIterationIds)].sort((first, second) => first - second);
    const comparisonIndex = compareToIterationId === 0 ? -1 : available.indexOf(compareToIterationId);
    if (compareToIterationId !== 0 && comparisonIndex < 0) { return []; }
    const firstIndex = comparisonIndex + 1;
    const lastIndex = available.indexOf(iterationId);
    return firstIndex >= 0 && lastIndex >= firstIndex
        ? available.slice(firstIndex, lastIndex + 1)
        : [];
}

export function iterationRangeDescription(range: IterationRange, latestIterationId: number): string {
    return iterationRangeDescriptionFromBounds(
        range.iterationId,
        range.compareToIterationId,
        latestIterationId,
    );
}

export function iterationRangeDescriptionFromBounds(
    iterationId: number,
    compareToIterationId: number,
    latestIterationId: number,
): string {
    if (compareToIterationId === 0 && iterationId === latestIterationId) {
        return 'Full pull request';
    }
    const firstIterationId = compareToIterationId === 0 ? 1 : compareToIterationId + 1;
    return firstIterationId === iterationId
        ? `Iteration ${iterationId}`
        : `Iterations ${firstIterationId}-${iterationId}`;
}