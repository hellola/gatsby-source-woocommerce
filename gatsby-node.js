const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;

const {
  processNode,
  normaliseFieldName,
  mapMediaToNodes,
  mapProductsToCategories,
  mapProductsToTags,
  mapGroupedProducts,
  asyncGetProductVariations,
  asyncGetProductAttributes,
  timeStampedLog,
} = require("./helpers");

const {
  getWCNodeId,
  mapNodeNormalizeMetadata,
} = require("./helpers/misc-data");

exports.sourceNodes = async (
  { actions, createNodeId, createContentDigest, store, cache },
  configOptions
) => {
  const { createNode, touchNode } = actions;
  delete configOptions.plugins;

  const {
    sites,
    per_page,
    wpAPIPrefix = null,
    fields,
    query_string_auth = false,
    port = "",
    encoding = "",
    axios_config = null,
    verbose = true,
  } = configOptions;

  const wooApis = {};
  // set up WooCommerce node api tool
  const WooCommerce = (site) => {
    const { api, https, api_keys, siteName, api_version = "wc/v3" } = site;

    if (wooApis[siteName]) {
      return wooApis[siteName];
    }

    const wooApi = new WooCommerceRestApi({
      url: `http${https ? "s" : ""}://${api}`,
      consumerKey: api_keys.consumer_key,
      consumerSecret: api_keys.consumer_secret,
      version: api_version,
      wpAPIPrefix,
      queryStringAuth: query_string_auth,
      port,
      encoding,
      axiosConfig: axios_config,
    });
    wooApis[siteName] = wooApi;
    return wooApi;
  };

  // Fetch Node data for a given field name
  const fetchNodes = async (fieldName, site) => {
    let data_ = [];
    let page = 1;
    let pages;

    do {
      let args = per_page ? { per_page, page } : { page };
      const wooApi = WooCommerce(site);
      await wooApi
        .get(fieldName, args)
        .then((response) => {
          if (response.status === 200) {
            data_ = [...data_, ...response.data];
            pages = parseInt(response.headers["x-wp-totalpages"]);
            page++;
          } else {
            console.warn(`
              ========== WARNING FOR FIELD ${fieldName} ===========
              The following error status was produced: ${response.data}
              ================== END WARNING ==================
            `);
            return [];
          }
        })
        .catch((error) => {
          console.warn(`
            ========== WARNING FOR FIELD ${fieldName} ===========
            The following error status was produced: ${error}
            ================== END WARNING ==================
          `);
          return [];
        });
    } while (page <= pages);

    return data_;
  };

  // Loop over each field set in configOptions and process/create nodes
  async function fetchNodesAndCreate(array, site) {
    const { siteName = "" } = site;
    timeStampedLog(
      `gatsby-source-woocommerce: loading fields (site: ${siteName}): ${JSON.stringify(array)}`
    );

    let nodes = [];
    for (const field of array) {
      const fieldName = normaliseFieldName(field);
      let tempNodes = await fetchNodes(field, site);
      if (verbose) {
        timeStampedLog(
          `gatsby-source-woocommerce: Fetching ${tempNodes.length} nodes for field: ${field}`
        );
      }
      tempNodes = tempNodes.map((node) => ({
        ...node,
        site_name: siteName,
        id: createNodeId(
          `woocommerce-${siteName}-${fieldName}-${getWCNodeId(node, fieldName)}`
        ),
        wordpress_id: getWCNodeId(node, fieldName),
        wordpress_parent_id: node.parent,
        __type: `wc${fieldName[0].toUpperCase() + fieldName.slice(1)}`,
      }));
      nodes = nodes.concat(tempNodes);
      if (verbose) {
        timeStampedLog(
          `gatsby-source-woocommerce: Completed fetching nodes for field: ${field}`
        );
      }
    }
    nodes = await asyncGetProductVariations(nodes, WooCommerce(site), verbose);
    nodes = await asyncGetProductAttributes(nodes, WooCommerce(site), verbose);
    nodes = await mapMediaToNodes({
      nodes,
      store,
      cache,
      createNode,
      createNodeId,
      touchNode,
    });

    let startTime = new Date().getTime();

    nodes = mapProductsToCategories(nodes);
    nodes = mapProductsToTags(nodes);
    nodes = mapGroupedProducts(nodes);
    nodes = mapNodeNormalizeMetadata(nodes);

    nodes = nodes.map((node) =>
      processNode(createContentDigest, node, verbose, startTime)
    );

    nodes.forEach((node) => {
      createNode(node);
    });
    if (verbose) {
      timeStampedLog(
        `gatsby-source-woocommerce: ${
          nodes.length
        } nodes mapped, processed, and created in ${
          (new Date().getTime() - startTime) / 1000
        }s`
      );
    }
  }

  for (site of sites) {
    await fetchNodesAndCreate(fields, site);
  }
  return;
};

exports.createSchemaCustomization = ({ actions, schema }, configOptions) => {
  const { createTypes } = actions;
  const { fields } = configOptions;

  const typeDefs = fields.map((field) => {
    const fieldName = normaliseFieldName(field);
    const fieldType = `wc${fieldName[0].toUpperCase() + fieldName.slice(1)}`;

    return schema.buildObjectType({
      name: fieldType,
      fields: {
        wordpress_parent: {
          type: fieldType,
          resolve(source, args, context, info) {
            return context.nodeModel
              .getAllNodes({ type: fieldType })
              .find((node) => node.wordpress_id === source.wordpress_parent_id);
          },
        },
        wordpress_children: {
          type: `[${fieldType}]`,
          resolve(source, args, context, info) {
            return context.nodeModel
              .getAllNodes({ type: fieldType })
              .filter(
                (node) => node.wordpress_parent_id === source.wordpress_id
              );
          },
        },
      },
      interfaces: ["Node"],
    });
  });

  createTypes(typeDefs);
};
