import * as assert from 'assert';
import {
    hasSuggestion,
    extractSuggestion,
    extractCommentText,
    renderSuggestionAsDiff,
} from '../../views/suggestionRenderer';

suite('hasSuggestion', () => {
    test('returns true for content with suggestion block', () => {
        assert.ok(hasSuggestion('Please fix:\n```suggestion\nconst x = 1;\n```'));
    });

    test('returns false for regular content', () => {
        assert.ok(!hasSuggestion('This looks good'));
    });

    test('returns false for regular code blocks', () => {
        assert.ok(!hasSuggestion('```typescript\nconst x = 1;\n```'));
    });

    test('returns false for empty string', () => {
        assert.ok(!hasSuggestion(''));
    });
});

suite('extractSuggestion', () => {
    test('extracts single-line suggestion', () => {
        const result = extractSuggestion('```suggestion\nconst x = 1;\n```');
        assert.strictEqual(result, 'const x = 1;');
    });

    test('extracts multi-line suggestion', () => {
        const result = extractSuggestion('```suggestion\nline1\nline2\nline3\n```');
        assert.strictEqual(result, 'line1\nline2\nline3');
    });

    test('returns undefined for no suggestion', () => {
        assert.strictEqual(extractSuggestion('just a comment'), undefined);
    });

    test('extracts suggestion with surrounding text', () => {
        const result = extractSuggestion('Fix this:\n```suggestion\nfixed code\n```\nThanks!');
        assert.strictEqual(result, 'fixed code');
    });

    test('handles suggestion block with leading whitespace after fence', () => {
        const result = extractSuggestion('```suggestion  \ncode\n```');
        assert.strictEqual(result, 'code');
    });
});

suite('extractCommentText', () => {
    test('returns text without suggestion block', () => {
        const result = extractCommentText('Fix this:\n```suggestion\ncode\n```\nThanks!');
        assert.strictEqual(result, 'Fix this:\n\nThanks!');
    });

    test('returns full content when no suggestion', () => {
        assert.strictEqual(extractCommentText('just a comment'), 'just a comment');
    });

    test('returns empty for suggestion-only content', () => {
        const result = extractCommentText('```suggestion\ncode\n```');
        assert.strictEqual(result, '');
    });
});

suite('renderSuggestionAsDiff', () => {
    test('renders single-line diff', () => {
        const result = renderSuggestionAsDiff(
            ['const x = old;'],
            'const x = new;',
        );
        assert.ok(result.includes('```diff'));
        assert.ok(result.includes('- const x = old;'));
        assert.ok(result.includes('+ const x = new;'));
    });

    test('renders multi-line diff', () => {
        const result = renderSuggestionAsDiff(
            ['line1', 'line2'],
            'newLine1\nnewLine2',
        );
        assert.ok(result.includes('- line1'));
        assert.ok(result.includes('- line2'));
        assert.ok(result.includes('+ newLine1'));
        assert.ok(result.includes('+ newLine2'));
    });

    test('includes comment text when provided', () => {
        const result = renderSuggestionAsDiff(
            ['old'],
            'new',
            'Please change this',
        );
        assert.ok(result.includes('Please change this'));
        assert.ok(result.includes('```diff'));
    });

    test('omits comment text when not provided', () => {
        const result = renderSuggestionAsDiff(
            ['old'],
            'new',
        );
        assert.ok(result.startsWith('```diff'));
    });

    test('handles empty original lines', () => {
        const result = renderSuggestionAsDiff(
            [],
            'new code',
        );
        assert.ok(!result.includes('- '));
        assert.ok(result.includes('+ new code'));
    });

    test('uses replacedLines for + side when provided', () => {
        // Simulates: original line "This is a section i am adding"
        // Suggestion replaces only "adding" with "talking about"
        // replacedLines is the full line with the span replaced
        const result = renderSuggestionAsDiff(
            ['This is a section i am adding'],
            'talking about',
            undefined,
            ['This is a section i am talking about'],
        );
        assert.ok(result.includes('- This is a section i am adding'));
        assert.ok(result.includes('+ This is a section i am talking about'));
        // Should NOT show just "talking about" on the + side
        assert.ok(!result.includes('+ talking about\n'));
    });

    test('replacedLines preserves prefix and suffix from original', () => {
        const result = renderSuggestionAsDiff(
            ['  const x = oldValue; // comment'],
            'newValue',
            undefined,
            ['  const x = newValue; // comment'],
        );
        assert.ok(result.includes('-   const x = oldValue; // comment'));
        assert.ok(result.includes('+   const x = newValue; // comment'));
    });

    test('falls back to suggestedCode when replacedLines not provided', () => {
        const result = renderSuggestionAsDiff(
            ['old line'],
            'new line',
        );
        assert.ok(result.includes('+ new line'));
    });

    test('replacedLines with mid-line replacement renders correct diff', () => {
        // Simulates the "View Original Context" scenario:
        // Original: "- This is a section i am adding"
        // Suggestion replaces "adding" (columns 28-34) with "talking about"
        // replacedLines should be the full line with just the span swapped
        const original = ['- This is a section i am adding'];
        const replaced = ['- This is a section i am talking about'];
        const result = renderSuggestionAsDiff(
            original,
            'talking about',
            undefined,
            replaced,
        );
        assert.ok(result.includes('- - This is a section i am adding'), 'should show original line with -');
        assert.ok(result.includes('+ - This is a section i am talking about'), 'should show full replaced line with +');
        // Must NOT produce broken output like "+ talking about- This is a section..."
        assert.ok(!result.includes('+ talking about-'), 'must not concatenate suggestion with original');
    });
});
