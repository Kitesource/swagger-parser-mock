const URL = require('url')
const memoizee = require('memoizee')
const swagger = require('swagger-client')
const swaggerTools = require('swagger-tools').specs.v1

const utils = require('./utils')
const primitives = require('./primitives')

function primitive (schema) {
  schema = utils.objectify(schema)

  const type = schema.type
  const format = schema.format
  const value = primitives[type + '_' + format] || primitives[type]

  if (typeof schema.example === 'undefined') {
    return value || 'Unknown Type: ' + schema.type
  }

  return schema.example
}

function sampleFromSchema (schema) {
  schema = utils.objectify(schema)

  let type = schema.type
  const properties = schema.properties
  const additionalProperties = schema.additionalProperties
  const items = schema.items

  if (!type) {
    if (properties) {
      type = 'object'
    } else if (items) {
      type = 'array'
    } else {
      return
    }
  }

  if (type === 'object') {
    const props = utils.objectify(properties)
    const obj = {}
    for (let name in props) {
      obj[name] = sampleFromSchema(props[name])
    }

    if (additionalProperties === true) {
      obj.additionalProp1 = {}
    } else if (additionalProperties) {
      const additionalProps = utils.objectify(additionalProperties)
      const additionalPropVal = sampleFromSchema(additionalProps)

      for (let i = 1; i < 4; i++) {
        obj['additionalProp' + i] = additionalPropVal
      }
    }
    return obj
  }

  if (type === 'array') {
    return [sampleFromSchema(items)]
  }

  if (schema['enum']) {
    if (schema['default']) return schema['default']
    return utils.normalizeArray(schema['enum'])[0]
  }

  if (type === 'file') {
    return
  }

  return primitive(schema)
}

const memoizedSampleFromSchema = memoizee(sampleFromSchema)

function getSampleSchema (schema) {
  return JSON.stringify(memoizedSampleFromSchema(schema), null, 2)
}

/**
 * 处理 1.x 文档中，array 类型下 items.type 无法解析 model 的问题
 *
 * { a: { type: 'array', items: { type: 'Pet' } }, models: { Pet: {} } }
 * =>
 * { a: { type: 'array', items: { $ref: 'Pet' } }, models: { Pet: {} } }
 *
 * @param {*} obj
 * @param {*} models
 */
function renameTypeKey (obj, models) {
  models = models || {}
  if (!obj || (obj && typeof obj !== 'object')) return
  Object.keys(obj).forEach(key => {
    const value = obj[key]
    if (value && typeof value === 'object') {
      renameTypeKey(value, models)
    }

    if (key === 'type' &&
      value === 'array' &&
      obj.items &&
      obj.items.type &&
      models[obj.items.type]) {
      obj.items.$ref = obj.items.type
      delete obj.items.type
    }
  })
}

const parser = module.exports = function (url, opts) {
  opts = opts || {}

  if (typeof url === 'string') {
    opts.url = url
  } else {
    opts = url
  }

  return swagger(opts).then(function (res) {
    const spec = res.spec
    const openapi = spec.openapi || ''
    const version = openapi.slice(0, openapi.indexOf('.'))
    const isOAS3 = spec.openapi && parseInt(version) >= 3
    if (spec.swaggerVersion) { // v1
      const paths = spec.apis.map(function (api) {
        let baseUrl = res.url
        if (!/\.json$/.test(baseUrl)) {
          baseUrl += '/'
        }
        opts.url = URL.resolve(baseUrl, api.path.replace(/^\//, ''))
        return swagger(opts)
      })
      return Promise.all(paths).then(function (apis) {
        const specs = apis.map(function (o) { return o.spec })
        return new Promise(function (resolve, reject) {
          for (let spec of specs) {
            renameTypeKey(spec, spec.models)
          }
          swaggerTools.convert(spec, specs, true, function (error, docs) {
            if (error) return reject(error)
            resolve(parser({ spec: docs }))
          })
        })
      })
    } else {
      for (let path in spec.paths) {
        for (let method in spec.paths[path]) {
          const api = spec.paths[path][method]
          let schema
          for (let code in api.responses) {
            const response = api.responses[code]
            if (isOAS3) {
              schema = response.content &&
                response.content['application/json'] &&
                utils.inferSchema(response.content['application/json'])
              response.example = schema ? getSampleSchema(schema) : null
            } else {
              schema = utils.inferSchema(response)
              response.example = schema ? getSampleSchema(schema) : null
            }
          }
          if (!api.parameters) continue
          for (let parameter of api.parameters) {
            schema = utils.inferSchema(parameter)
            parameter.example = schema ? getSampleSchema(schema) : null
          }
        }
      }
    }
    return spec
  })
}
