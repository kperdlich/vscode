/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { HighlightedLabel, IHighlight } from 'vs/base/browser/ui/highlightedlabel/highlightedLabel';
import { IInputValidationOptions, InputBox } from 'vs/base/browser/ui/inputbox/inputBox';
import { ITreeNode, ITreeRenderer } from 'vs/base/browser/ui/tree/tree';
import { createMatches, FuzzyScore } from 'vs/base/common/filters';
import { once } from 'vs/base/common/functional';
import { KeyCode } from 'vs/base/common/keyCodes';
import { DisposableStore, dispose, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { attachInputBoxStyler } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { LinkDetector } from 'vs/workbench/contrib/debug/browser/linkDetector';
import { IDebugService, IExpression, IExpressionContainer } from 'vs/workbench/contrib/debug/common/debug';
import { Expression, ExpressionContainer, Variable } from 'vs/workbench/contrib/debug/common/debugModel';
import { ReplEvaluationResult } from 'vs/workbench/contrib/debug/common/replModel';

export const MAX_VALUE_RENDER_LENGTH_IN_VIEWLET = 1024;
export const twistiePixels = 20;
const booleanRegex = /^(true|false)$/i;
const stringRegex = /^(['"]).*\1$/;
const $ = dom.$;

export interface IRenderValueOptions {
	showChanged?: boolean;
	maxValueLength?: number;
	showHover?: boolean;
	colorize?: boolean;
	linkDetector?: LinkDetector;
}

export interface IVariableTemplateData {
	expression: HTMLElement;
	name: HTMLElement;
	value: HTMLElement;
	label: HighlightedLabel;
	lazyButton: HTMLElement;
}

export function renderViewTree(container: HTMLElement): HTMLElement {
	const treeContainer = $('.');
	treeContainer.classList.add('debug-view-content');
	container.appendChild(treeContainer);
	return treeContainer;
}

export function renderExpressionValue(expressionOrValue: IExpressionContainer | string, container: HTMLElement, options: IRenderValueOptions): void {
	let value = typeof expressionOrValue === 'string' ? expressionOrValue : expressionOrValue.value;

	// remove stale classes
	container.className = 'value';
	// when resolving expressions we represent errors from the server as a variable with name === null.
	if (value === null || ((expressionOrValue instanceof Expression || expressionOrValue instanceof Variable || expressionOrValue instanceof ReplEvaluationResult) && !expressionOrValue.available)) {
		container.classList.add('unavailable');
		if (value !== Expression.DEFAULT_VALUE) {
			container.classList.add('error');
		}
	} else if ((expressionOrValue instanceof ExpressionContainer) && options.showChanged && expressionOrValue.valueChanged && value !== Expression.DEFAULT_VALUE) {
		// value changed color has priority over other colors.
		container.className = 'value changed';
		expressionOrValue.valueChanged = false;
	}

	if (options.colorize && typeof expressionOrValue !== 'string') {
		if (expressionOrValue.type === 'number' || expressionOrValue.type === 'boolean' || expressionOrValue.type === 'string') {
			container.classList.add(expressionOrValue.type);
		} else if (!isNaN(+value)) {
			container.classList.add('number');
		} else if (booleanRegex.test(value)) {
			container.classList.add('boolean');
		} else if (stringRegex.test(value)) {
			container.classList.add('string');
		}
	}

	if (options.maxValueLength && value && value.length > options.maxValueLength) {
		value = value.substring(0, options.maxValueLength) + '...';
	}
	if (!value) {
		value = '';
	}

	if (options.linkDetector) {
		container.textContent = '';
		const session = (expressionOrValue instanceof ExpressionContainer) ? expressionOrValue.getSession() : undefined;
		container.appendChild(options.linkDetector.linkify(value, false, session ? session.root : undefined));
	} else {
		container.textContent = value;
	}
	if (options.showHover) {
		container.title = value || '';
	}
}

export function renderVariable(variable: Variable, data: IVariableTemplateData, showChanged: boolean, highlights: IHighlight[], linkDetector?: LinkDetector): void {
	if (variable.available) {
		let text = variable.name;
		if (variable.value && typeof variable.name === 'string') {
			text += ':';
		}
		data.label.set(text, highlights, variable.type ? variable.type : variable.name);
		data.name.classList.toggle('virtual', variable.presentationHint?.kind === 'virtual');
		data.name.classList.toggle('internal', variable.presentationHint?.visibility === 'internal');
	} else if (variable.value && typeof variable.name === 'string' && variable.name) {
		data.label.set(':');
	}

	data.expression.classList.toggle('lazy', !!variable.presentationHint?.lazy);
	renderExpressionValue(variable, data.value, {
		showChanged,
		maxValueLength: MAX_VALUE_RENDER_LENGTH_IN_VIEWLET,
		showHover: true,
		colorize: true,
		linkDetector
	});
}

export interface IInputBoxOptions {
	initialValue: string;
	ariaLabel: string;
	placeholder?: string;
	validationOptions?: IInputValidationOptions;
	onFinish: (value: string, success: boolean) => void;
}

export interface IExpressionTemplateData {
	expression: HTMLElement;
	name: HTMLSpanElement;
	value: HTMLSpanElement;
	inputBoxContainer: HTMLElement;
	actionBar?: ActionBar;
	elementDisposable: IDisposable[];
	templateDisposable: IDisposable;
	label: HighlightedLabel;
	lazyButton: HTMLElement;
	currentElement: IExpression | undefined;
}

export abstract class AbstractExpressionsRenderer implements ITreeRenderer<IExpression, FuzzyScore, IExpressionTemplateData> {

	constructor(
		@IDebugService protected debugService: IDebugService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IThemeService private readonly themeService: IThemeService
	) { }

	abstract get templateId(): string;

	renderTemplate(container: HTMLElement): IExpressionTemplateData {
		const expression = dom.append(container, $('.expression'));
		const name = dom.append(expression, $('span.name'));
		const value = dom.append(expression, $('span.value'));
		const lazyButton = dom.append(expression, $('span.lazy-button'));
		lazyButton.textContent = `(...)`;

		const label = new HighlightedLabel(name);

		const inputBoxContainer = dom.append(expression, $('.inputBoxContainer'));

		const templateDisposable = new DisposableStore();

		let actionBar: ActionBar | undefined;
		if (this.renderActionBar) {
			dom.append(expression, $('.span.actionbar-spacer'));
			actionBar = templateDisposable.add(new ActionBar(expression));
		}

		const template: IExpressionTemplateData = { expression, name, value, label, inputBoxContainer, actionBar, elementDisposable: [], templateDisposable, lazyButton, currentElement: undefined };

		templateDisposable.add(dom.addDisposableListener(lazyButton, dom.EventType.CLICK, () => {
			if (template.currentElement) {
				this.debugService.getViewModel().evaluateLazyExpression(template.currentElement);
			}
		}));

		return template;
	}

	renderElement(node: ITreeNode<IExpression, FuzzyScore>, index: number, data: IExpressionTemplateData): void {
		const { element } = node;
		data.currentElement = element;
		this.renderExpression(element, data, createMatches(node.filterData));
		if (data.actionBar) {
			this.renderActionBar!(data.actionBar, element, data);
		}
		const selectedExpression = this.debugService.getViewModel().getSelectedExpression();
		if (element === selectedExpression?.expression || (element instanceof Variable && element.errorMessage)) {
			const options = this.getInputBoxOptions(element, !!selectedExpression?.settingWatch);
			if (options) {
				data.elementDisposable.push(this.renderInputBox(data.name, data.value, data.inputBoxContainer, options));
			}
		}
	}

	renderInputBox(nameElement: HTMLElement, valueElement: HTMLElement, inputBoxContainer: HTMLElement, options: IInputBoxOptions): IDisposable {
		nameElement.style.display = 'none';
		valueElement.style.display = 'none';
		inputBoxContainer.style.display = 'initial';

		const inputBox = new InputBox(inputBoxContainer, this.contextViewService, options);
		const styler = attachInputBoxStyler(inputBox, this.themeService);

		inputBox.value = options.initialValue;
		inputBox.focus();
		inputBox.select();

		const done = once((success: boolean, finishEditing: boolean) => {
			nameElement.style.display = 'initial';
			valueElement.style.display = 'initial';
			inputBoxContainer.style.display = 'none';
			const value = inputBox.value;
			dispose(toDispose);

			if (finishEditing) {
				this.debugService.getViewModel().setSelectedExpression(undefined, false);
				options.onFinish(value, success);
			}
		});

		const toDispose = [
			inputBox,
			dom.addStandardDisposableListener(inputBox.inputElement, dom.EventType.KEY_DOWN, (e: IKeyboardEvent) => {
				const isEscape = e.equals(KeyCode.Escape);
				const isEnter = e.equals(KeyCode.Enter);
				if (isEscape || isEnter) {
					e.preventDefault();
					e.stopPropagation();
					done(isEnter, true);
				}
			}),
			dom.addDisposableListener(inputBox.inputElement, dom.EventType.BLUR, () => {
				done(true, true);
			}),
			dom.addDisposableListener(inputBox.inputElement, dom.EventType.CLICK, e => {
				// Do not expand / collapse selected elements
				e.preventDefault();
				e.stopPropagation();
			}),
			styler
		];

		return toDisposable(() => {
			done(false, false);
		});
	}

	protected abstract renderExpression(expression: IExpression, data: IExpressionTemplateData, highlights: IHighlight[]): void;
	protected abstract getInputBoxOptions(expression: IExpression, settingValue: boolean): IInputBoxOptions | undefined;

	protected renderActionBar?(actionBar: ActionBar, expression: IExpression, data: IExpressionTemplateData): void;

	disposeElement(node: ITreeNode<IExpression, FuzzyScore>, index: number, templateData: IExpressionTemplateData): void {
		dispose(templateData.elementDisposable);
		templateData.elementDisposable = [];
	}

	disposeTemplate(templateData: IExpressionTemplateData): void {
		dispose(templateData.elementDisposable);
		templateData.templateDisposable.dispose();
	}
}
