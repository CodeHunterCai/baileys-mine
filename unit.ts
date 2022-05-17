/* eslint-disable prefer-const */
function log(arg: any, str: string = '') {
	const color = '\x1B[32m'
	str = str + '============================================================'
	console.error(color, str)
	console.log(arg)
	console.error('', str)
}

export {
	log
}